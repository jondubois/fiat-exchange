const crypto = require('crypto');
const uuid = require('uuid');
const {getShardKey, getShardRange} = require('../utils/sharding');
const AsyncStreamEmitter = require('async-stream-emitter');
const {generateWallet} = require('../utils/blockchain');

const SALT_SIZE = 32;
const MAX_WALLET_CREATE_ATTEMPTS = 10;

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 30;

const MIN_PASSWORD_LENGTH = 7;
const MAX_PASSWORD_LENGTH = 50;

class AccountService extends AsyncStreamEmitter {
  constructor(options) {
    super();

    this.thinky = options.thinky;
    this.crud = options.crud;
    this.mainInfo = options.mainInfo;
    this.shardIndex = null;
    this.shardCount = null;
  }

  setShardInfo(shardIndex, shardCount) {
    this.shardIndex = shardIndex;
    this.shardCount = shardCount;
  }

  async getAccountsByDepositWalletAddress(walletAddress) {
    if (walletAddress == null) {
      return [];
    }
    return this.thinky.r.table('Account').getAll(walletAddress, {index: 'depositWalletAddress'}).run();
  }

  async fetchTransactionTargetAccount(blockchainTransaction) {
    let walletAccountList = await this.getAccountsByDepositWalletAddress(blockchainTransaction.senderId);
    return walletAccountList[0];
  }

  async execTransaction(transaction) {
    let settlementShardKey = getShardKey(transaction.accountId);
    return this.crud.create({
      type: 'Transaction',
      value: {
        createdDate: this.thinky.r.now(),
        settled: false,
        settlementShardKey,
        ...transaction
      }
    });
  }

  async execDepositTransaction(blockchainTransaction) {
    let account = await this.fetchTransactionTargetAccount(blockchainTransaction);
    if (!account) {
      return {
        deposit: null,
        transaction: null
      };
    }

    let transactionId = uuid.v4();
    let deposit = {
      id: blockchainTransaction.id,
      accountId: account.id,
      transactionId,
      height: blockchainTransaction.height,
      createdDate: this.thinky.r.now()
    };
    let insertedDeposit;
    try {
      insertedDeposit = await this.crud.create({
        type: 'Deposit',
        value: deposit
      });
    } catch (error) {
      // Check if the deposit and transaction have already been created.
      // If a deposit exists without a matching transaction (e.g. because of a
      // past insertion failure), create the matching transaction.
      let deposit;
      try {
        deposit = await this.crud.read({
          type: 'Deposit',
          id: blockchainTransaction.id
        });
      } catch (err) {
        throw new Error(
          `Failed to create deposit with external ID ${
            blockchainTransaction.id
          } and no existing one could be found - ${error}`
        );
      }
      try {
        let txn = await this.crud.read({
          type: 'Transaction',
          id: deposit.transactionId
        });
        return {
          deposit,
          transaction: txn
        };
      } catch (err) {
        transactionId = deposit.transactionId;
      }
    }
    let transaction = {
      id: transactionId,
      accountId: account.id,
      type: 'deposit',
      amount: String(blockchainTransaction.amount)
    };
    let insertedTransaction = await this.execTransaction(transaction);
    return {
      deposit,
      transaction: insertedTransaction
    };
  }

  async fetchAccountBalance(accountId) {
    return this.thinky.r.table('Transaction')
    .getAll(accountId, {index: 'accountId'})
    .orderBy(this.thinky.r.desc('createdDate'))
    .nth(0)
    .getField('amount');
  }

  async fetchAccountSettlementLedger() {
    if (this.shardIndex == null || this.shardCount == null) {
      return {};
    }
    // Only fetch transactions from accounts which are within the
    // shard range as the current worker.
    let shardRange = getShardRange(this.shardIndex, this.shardCount);
    let txns = await this.thinky.r.table('Transaction')
    .between(shardRange.start, shardRange.end, {index: 'settlementShardKey'})
    .orderBy(this.thinky.r.asc('createdDate'))
    .run();

    if (!txns.length) {
      return {};
    }

    let accountLedger = {};
    txns.forEach((txn) => {
      if (!accountLedger[txn.accountId]) {
        accountLedger[txn.accountId] = {
          balance: 0n,
          lastSettledTransaction: null,
          unsettledTransactions: [],
        };
      }
      let account = accountLedger[txn.accountId];
      if (txn.settled) {
        account.lastSettledTransaction = txn;
        account.balance = BigInt(txn.balance);
      } else {
        account.unsettledTransactions.push(txn);
      }
    });

    return accountLedger;
  }

  async settlePendingTransactions() {
    let accountLedger = await this.fetchAccountSettlementLedger();
    let unsettledAccoundIds = Object.keys(accountLedger);

    await Promise.all(
      unsettledAccoundIds.map(async (accountId) => {
        let account = accountLedger[accountId];
        await Promise.all(
          account.unsettledTransactions.map(async (txn) => {
            if (txn.type === 'withdrawal') {
              let newBalance = account.balance - BigInt(txn.amount);
              if (newBalance >= 0n) {
                account.balance = newBalance;
              } else {
                txn.canceled = true;
              }
            } else if (txn.type === 'debit') {
              let newBalance = account.balance - BigInt(txn.amount);
              if (newBalance >= 0n) {
                account.balance = newBalance;
              } else {
                txn.canceled = true;
              }
            } else if (txn.type === 'credit') {
              account.balance += BigInt(txn.amount);
            } else if (txn.type === 'deposit') {
              account.balance += BigInt(txn.amount);
            }

            txn.balance = account.balance.toString();
            txn.settled = true;
            txn.settledDate = this.thinky.r.now();

            let {id, txnData} = txn;
            await this.crud.update({
              type: 'Transaction',
              id,
              value: txnData
            });
          })
        );
      })
    );

    await Promise.all(
      unsettledAccoundIds.map(async (accountId) => {
        let account = accountLedger[accountId];
        let txnsToRemoveShardKey = [];
        if (account.lastSettledTransaction) {
          txnsToRemoveShardKey.push(account.lastSettledTransaction);
        }
        // Remove the settlement shard key from all settled transactions except for the last one.
        txnsToRemoveShardKey = txnsToRemoveShardKey
        .concat(account.unsettledTransactions)
        .filter(txn => txn.settled);
        txnsToRemoveShardKey = txnsToRemoveShardKey.slice(0, txnsToRemoveShardKey.length - 1);

        await Promise.all(
          txnsToRemoveShardKey.map(async (txn) => {
            await this.crud.delete({
              type: 'Transaction',
              id: txn.id,
              field: 'settlementShardKey'
            });
          })
        );
      })
    );
  }

  async settleTransaction(transactionId) {
    let result = await this.thinky.r.table('Transaction')
    .get(transactionId)
    .update({settled: true, settledDate: this.thinky.r.now()})
    .run();

    if (!result.replaced) {
      throw new Error(
        `Failed to settle transaction ${transactionId}`
      );
    }
  }

  hashPassword(password, salt) {
    let hasher = crypto.createHash('sha256');
    hasher.update(password + salt);
    return hasher.digest('hex');
  }

  async sanitizeSignupCredentials(credentials) {
    credentials = {...credentials};
    if (!credentials || credentials.username == null || credentials.password == null) {
      let error = new Error('Account credentials were not provided.');
      error.name = 'NoCredentialsProvidedError';
      throw error;
    }
    if (
      typeof credentials.username !== 'string' ||
      credentials.username.length < MIN_USERNAME_LENGTH ||
      credentials.username.length > MAX_USERNAME_LENGTH
    ) {
      let error = new Error(
        `The provided username was invalid. It must be between ${
          MIN_USERNAME_LENGTH
        } and ${
          MAX_USERNAME_LENGTH
        } characters in length.`
      );
      error.name = 'InvalidUsernameError';
      throw error;
    }
    credentials.username = credentials.username.trim();

    if (
      typeof credentials.password !== 'string' ||
      credentials.password.length < MIN_PASSWORD_LENGTH ||
      credentials.password.length > MAX_PASSWORD_LENGTH
    ) {
      let error = new Error(
        `A password must be between ${
          MIN_PASSWORD_LENGTH
        } and ${
          MAX_PASSWORD_LENGTH
        } characters in length.`
      );
      error.name = 'InvalidPasswordError';
      throw error;
    }

    let randomBuffer = await new Promise((resolve, reject) => {
      crypto.randomBytes(SALT_SIZE, (err, randomBytesBuffer) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(randomBytesBuffer);
      });
    });

    credentials.active = true;

    // Add random password salt.
    credentials.passwordSalt = randomBuffer.toString('hex');
    // Only store the salted hash of the password.
    credentials.password = this.hashPassword(credentials.password, credentials.passwordSalt);
    credentials.createdDate = this.thinky.r.now();

    let isUsernameAvailable = false;
    try {
      // Verify that wallet address is not already taken.
      isUsernameAvailable = await this.thinky.r.table('Account')
      .getAll(credentials.username, {index: 'username'})
      .isEmpty()
      .run();
    } catch (error) {
      let badLookupError = new Error('Failed to check against existing account data in the database.');
      badLookupError.name = 'BadAccountLookupError';
      throw badLookupError;
    }

    if (!isUsernameAvailable) {
      let alreadyTakenError = new Error(
        `An account with the username ${credentials.username} already exists.`
      );
      alreadyTakenError.name = 'SignUpUsernameTakenError';
      throw alreadyTakenError;
    }

    let walletCreateAttempts = 0;
    while (true) {
      let wallet = generateWallet();

      credentials.depositWalletAddress = wallet.address;

      let isWalletAddressAvailable = false;

      try {
        isWalletAddressAvailable = await this.thinky.r.table('Account')
        .getAll(credentials.depositWalletAddress, {index: 'depositWalletAddress'})
        .isEmpty()
        .run();
      } catch (error) {
        let badLookupError = new Error('Failed to check against existing account data in the database.');
        badLookupError.name = 'BadAccountLookupError';
        throw badLookupError;
      }

      if (isWalletAddressAvailable) {
        credentials.depositWalletPassphrase = wallet.passphrase;
        credentials.depositWalletPrivateKey = wallet.privateKey;
        credentials.depositWalletPublicKey = wallet.publicKey;
        break;
      }
      if (++walletCreateAttempts >= MAX_WALLET_CREATE_ATTEMPTS) {
        let accountCreateError = new Error('Failed to generate an account wallet');
        accountCreateError.name = 'AccountCreateError';
        throw accountCreateError;
      }
    }

    return credentials;
  }

  async verifyLoginCredentials(credentials) {
    if (typeof credentials.username !== 'string') {
      let err = new Error('Username was in an invalid format');
      err.name = 'InvalidCredentialsError';
      throw err;
    }
    credentials.username = credentials.username.trim();

    let results = await this.thinky.r.table('Account')
    .getAll(credentials.username, {index: 'username'})
    .run();

    if (!results || !results[0]) {
      let err = new Error('Invalid username or password.');
      err.name = 'InvalidCredentialsError';
      throw err;
    }

    let accountData = results[0];

    if (accountData.active === false) {
      let accountInactiveError = new Error('Your account is currently disabled.');
      accountInactiveError.name = 'AccountInactiveError';
      throw accountInactiveError;
    }

    let hasher = crypto.createHash('sha256');
    hasher.update(credentials.password + accountData.passwordSalt);
    let hashedPassword = hasher.digest('hex');

    if (accountData.password !== hashedPassword) {
      let err = new Error('Wrong password.');
      err.name = 'InvalidCredentialsError';
      throw err;
    }
    return accountData;
  }
}

module.exports = AccountService;
