'use strict';

const Promise = require('bluebird').Promise;
const _awsSdk = require('aws-sdk');
const _dynamoDb = require('@awspilot/dynamodb');
const _shortId = require('shortid');
const SelectiveCopy = require('selective-copy');
const { argValidator: _argValidator } = require('@vamship/arg-utils');
const { ArgError } = require('@vamship/error-types').args;
const {
    DuplicateRecordError,
    ConcurrencyControlError
} = require('@vamship/error-types').data;
const _logger = require('@vamship/logger');

const LOG_METHODS = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
    'silent',
    'child'
];

const DEFAULT_COPIER = new SelectiveCopy([]);

/**
 * @external {SelectiveCopy}
 * @see {@link https://github.com/vamship/selective-copy}
 */
/**
 * @external {Logger}
 * @see {@link https://github.com/vamship/logger}
 */
/**
 * @external {ErrorTypes}
 * @see {@link https://github.com/vamship/error-types}
 */
/**
 * @external {DynamoDbClient}
 * @see {@link https://github.com/vamship/error-types}
 */
/**
 * Abstract representation of a single DynamoDB table, providing methods for
 * common CRUD operations. This is an opinionated implementation that injects
 * audit tracking fields and a field to support logical deletes. Methods are
 * provided for physical deletes if logical deletes are not necessary.
 *
 * <p>
 * The entities are by design lightweight, and do not perform too many
 * validations, like checking for data types on specific fields, user
 * authorization, etc. It is assumed that the caller of this module (like a
 * Lambda function) will perform these tasks.
 * </p>
 *
 * <p>
 * This class is intended to serve as a base class for specialized entity
 * classes that will implement multiple properties on the base class, including,
 * but not limited to [<b>tableName</b>]{@link Entity#tableName},
 * [<b>hashKey</b>]{@link Entity#hashKey},
 * [<b>rangeKey</b>]{@link Entity#rangeKey} (optional),
 * [<b>updateProps</b>]{@link Entity#updateProps}, and
 * [<b>updateProps</b>]{@link Entity#deleteProps}.
 * </p>
 */
class Entity {
    /**
     * Options object passed to the entity, containing references to a logger
     * object.
     *
     * @typedef {Object} Entity.Options
     * @property {Object} [logger] logger object that can be used write log
     *           messages. If omitted, a new log object will be created using
     *           the getLogger() method from the {@link external:Logger} module.
     * @property {String} [username='SYSTEM'] The username to use for audit log
     *           fields on the entity. This value may be overridden by
     *           passing in a username value for create/update calls.
     * @property {String} [awsRegion=undefined] The AWS region to use when
     *           initializing the client. Leave undefined to use the region
     *           defined by the execution environment. See
     *           [AWS DynamoDB documentation]{@link https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#constructor-property}
     *           for more information.
     */
    /**
     * A set of keys that uniquely identify the entity record in the table.
     *
     * @typedef {Object} Entity.Keys
     * @property {String} hashKey The partition key for the entity record.
     * @property {String} [rangeKey=undefined] A range key that for to identify
     *           the record. If omitted, no range key will be used for queries.
     */
    /**
     * Audit information for entity operations.
     *
     * @typedef {Object} Entity.Audit
     * @property {String} [username=] The username to associate with an entity
     *           in the audit log fields. If omitted, this value will default
     *           to the username specified via {@link Entity.Options},
     *           or failing that, to 'SYSTEM'
     */
    /**
     * @param {Entity.Options} [options={}] An options object that contains
     *        useful references for use within the entity.
     */
    constructor(options) {
        options = Object.assign({}, options);
        let { username, logger, awsRegion } = options;
        let isLoggerValid = LOG_METHODS.reduce((result, method) => {
            return result && _argValidator.checkFunction(logger[method]);
        }, _argValidator.checkObject(logger));

        if (!isLoggerValid) {
            logger = _logger.getLogger(this.constructor.name, {});
        }
        if (!_argValidator.checkString(username)) {
            username = 'SYSTEM';
        }
        if (!_argValidator.checkString(awsRegion)) {
            awsRegion = undefined;
        }
        this.__logger = logger.child({
            entity: this.tableName
        });
        this._username = username;
        this._awsRegion = awsRegion;
    }

    /**
     * Executes a query action, and returns the results of the query. If the
     * query throws an error, it will be mapped to a standard set of errors.
     *
     * @protected
     * @static
     * @param {Function} action A function that wraps the function exectution,
     *        and returns a promise that reflects the result of that operation.
     * @param {external:Logger} logger Reference to a logger object
     *
     * @return {Promise} A promise that will be rejected or resolved based on
     *         the outcome of the operation.
     */
    static _execQuery(action, logger) {
        const startTime = Date.now();
        logger.trace('Executing query');
        return action().then(
            (results) => {
                logger.info('Query execution completed', {
                    duration: Date.now() - startTime
                });
                return results;
            },
            (error) => {
                const { code, status } = error;
                logger.error('Error executing query', {
                    code,
                    status,
                    duration: Date.now() - startTime
                });
                logger.trace(error);
                throw error;
            }
        );
    }

    /**
     * Initializes and returns the dynamodb client. The client is created, and
     * associated with the table for this entity. All subsequent configuration
     * must be done elsewhere.
     *
     * @protected
     * @return {Object} A properly initialized client object.
     */
    _initClient() {
        return _dynamoDb(
            new _awsSdk.DynamoDB({
                region: this._awsRegion
            })
        ).table(this.tableName);
    }

    /**
     * The copier object for update operations. This is a reference to an
     * instance of the {@link external:SelectiveCopy} class that has been
     * initialized with the fields that will be copied from the input payload
     * to the entity record, in effect serving as a filter for fields that can
     * be updated.
     *
     * @protected
     * @type {external:SelectiveCopy}
     */
    get _updateCopier() {
        return DEFAULT_COPIER;
    }

    /**
     * The copier object for delete operations. This is a reference to an
     * instance of the {@link external:SelectiveCopy} class that has been
     * initialized with the fields that will be copied from the input payload
     * to the entity record, in effect serving as a filter for fields that can
     * be deleted.
     *
     * @protected
     * @type {external:SelectiveCopy}
     */
    get _deleteCopier() {
        return DEFAULT_COPIER;
    }

    /**
     * The logger object associated with the entity.
     *
     * @protected
     * @type {Object}
     */
    get _logger() {
        return this.__logger;
    }

    /**
     * Validates and extracts the hash key from the input object. The key is
     * extracted from the properties based on the
     * [hashKeyName]{@link Entity#hashKeyName} value of the current entity. An
     * error will be thrown if the input does not define a property with this
     * name.
     *
     * @protected
     * @param {Object} props An object of key value pairs
     *
     * @return {Number|String} The hash key value.
     * @throws {external:ErrorTypes} An ArgError will be thrown if the keys are
     *         invalid.
     */
    _getHashKey(props) {
        const hashKey = props[this.hashKeyName];

        const isValidString = _argValidator.checkString(hashKey);
        const isValidNumber = _argValidator.checkNumber(hashKey);

        if (!isValidString && !isValidNumber) {
            throw new ArgError(
                `Input does not define a valid hash key (${this.hashKeyName})`
            );
        }

        return hashKey;
    }

    /**
     * Validates and extracts the range key from the input object. The key is
     * extracted from the properties based on the
     * [rangeKeyName]{@link Entity#rangeKeyName} value of the current entity. An
     * error will be thrown if the input does not define a property with this
     * name.
     *
     * <p>
     * If the current entity does not define a
     * [rangeKeyName]{@link Entity#rangeKeyName], the range key value will not
     * be validated.
     * </p>
     *
     * @protected
     * @param {Object} props An object of key value pairs
     * @param {Boolean} [allowUndefined=false] If set to true, does not throw an
     *        error if the range key value is undefined.
     *
     * @return {Number|String} The range key value.
     * @throws {external:ErrorTypes} An ArgError will be thrown if the keys are
     *         invalid.
     */
    _getRangeKey(props, allowUndefined) {
        if (this.rangeKeyName !== undefined) {
            const rangeKey = props[this.rangeKeyName];

            if (typeof rangeKey === 'undefined' && allowUndefined) {
                return rangeKey;
            }

            const isValidString = _argValidator.checkString(rangeKey);
            const isValidNumber = _argValidator.checkNumber(rangeKey);

            if (!isValidString && !isValidNumber) {
                throw new ArgError(
                    `Input does not define a valid range key (${
                        this.rangeKeyName
                    })`
                );
            }

            return rangeKey;
        }
    }

    /**
     * Extracts the username from the audit object passed as an input.
     *
     * <p>
     * If a valid object is not specified, or if the object does not define a
     * valid username, the
     * [username]{@link Entity#username} property of the entity is returned.
     * </p>
     *
     * @protected
     * @param {Object} audit The audit object.
     *
     * @return {String} The username value
     */
    _getUsername(audit) {
        if (
            !_argValidator.checkObject(audit) ||
            !_argValidator.checkString(audit.username)
        ) {
            return this._username;
        }
        return audit.username;
    }

    /**
     * The name of the dynamodb table associated with this entity.
     *
     * @type {String}
     */
    get tableName() {
        return;
    }

    /**
     * The name of the dynamodb hash key for the current entity.
     *
     * @type {String}
     */
    get hashKeyName() {
        return;
    }

    /**
     * The name of the dynamodb range key for the current entity.
     *
     * @type {String}
     */
    get rangeKeyName() {
        return;
    }

    /**
     * Creates a new entity record in the dynamodb table.
     *
     * @param {Object} props An object of key value pairs representing the
     *        data associated with the entity.
     * @param {Entity.Audit} [audit={}] Audit information to associate with the
     *        query and entity record.
     *
     * @return {Promise} A promise that will be rejected/resolved based on the
     *         outcome of the create operation.
     */
    create(props, audit) {
        _argValidator.checkObject(props, 'Invalid props (arg #1)');

        const hashKey = this._getHashKey(props);
        const rangeKey = this._getRangeKey(props);
        const username = this._getUsername(audit);
        const logger = this._logger.child({
            operation: 'create',
            username,
            hashKey,
            rangeKey
        });

        logger.trace('Initializing DynamoDB client');
        let client = this._initClient();

        logger.trace('Augmenting input payload');
        const payload = Object.assign({}, props, {
            __deleted: 'no',
            __version: _shortId.generate(),
            __createdBy: username,
            __createDate: Date.now(),
            __updatedBy: username,
            __updateDate: Date.now()
        });

        logger.trace('Inserting entity record');
        const action = Promise.promisify(client.insert.bind(client, payload));
        return Entity._execQuery(action, logger).then(undefined, (error) => {
            if (error.code === 'ConditionalCheckFailedException') {
                logger.error('Conditional check failed on insert');
                throw new DuplicateRecordError();
            } else {
                throw error;
            }
        });
    }

    /**
     * Returns an existing entity from the dynamodb table.
     *
     * @param {Entity.Keys} keys A set of key(s) that uniquely identify the
     *        entity record in the table.
     * @param {Entity.Audit} [audit={}] Audit information to associate with the
     *        query.
     *
     * @return {Promise} A promise that will be rejected/resolved based on the
     *         outcome of the create operation. If resolved, the data will
     *         contain the entity record.
     */
    lookup(keys, audit) {
        _argValidator.checkObject(keys, 'Invalid keys (arg #1)');

        const hashKey = this._getHashKey(keys);
        const rangeKey = this._getRangeKey(keys);
        const username = this._getUsername(audit);
        const logger = this._logger.child({
            operation: 'lookup',
            username,
            hashKey,
            rangeKey
        });

        logger.trace('Initializing DynamoDB client');
        let client = this._initClient();

        logger.trace('Adding query conditions');
        client = client.where(this.hashKeyName).eq(hashKey);
        if (typeof rangeKey !== 'undefined') {
            client = client.where(this.rangeKeyName).eq(rangeKey);
        }
        client = client.if('__deleted').eq('no');

        logger.trace('Looking up entity record');
        const action = Promise.promisify(client.get.bind(client));
        return Entity._execQuery(action, logger);
    }

    /**
     * Returns a list of entities that match the hash key.
     *
     * @param {Entity.Keys} keys A set of key(s) that will be used in the list
     *        query. All queries will use the hash key to fetch a list of
     *        records. If a range key is specified, it will be used to generate
     *        a continuation token for the list query. The continuation token,
     *        taken in conjunction with the <b>count</b> option can be used to
     *        perform paged fetches.
     *        <p>
     *        If omitted, all records will be returned starting from the first
     *        record in the table.
     *        </p>
     * @param {Number} [count=undefined] The number of records to return in a
     *        single fetch operation. If omitted, all records for the entity
     *        will be returned.
     * @param {Entity.Audit} [audit={}] Audit information to associate with the
     *        query.
     *
     * @return {Promise} A promise that will be rejected/resolved based on the
     *         outcome of the create operation. If resolved, the data will
     *         contain a list of entities that match the search conditions.
     */
    list(keys, count, audit) {
        _argValidator.checkObject(keys, 'Invalid keys (arg #1)');

        const hashKey = this._getHashKey(keys);
        const rangeKey = this._getRangeKey(keys, true);
        const username = this._getUsername(audit);
        const logger = this._logger.child({
            operation: 'list',
            username,
            hashKey,
            rangeKey,
            count
        });

        logger.trace('Initializing DynamoDB client');
        let client = this._initClient();

        logger.trace('Adding query conditions');
        client = client.where(this.hashKeyName).eq(hashKey);
        client = client.having('__deleted').eq('no');
        if (typeof rangeKey !== 'undefined') {
            logger.trace('Adding resume token');
            client = client.resume({
                [this.hashKeyName]: {
                    S: hashKey
                },
                [this.rangeKeyName]: {
                    S: rangeKey
                }
            });
        }
        if (_argValidator.checkNumber(count)) {
            logger.trace('Adding query limit');
            client = client.limit(count);
        }

        logger.trace('Retrieving entity record list');
        const action = Promise.promisify(client.query.bind(client));
        return Entity._execQuery(action, logger);
    }

    /**
     * Updates an existing entity record in the dynamodb table.
     *
     * @param {Entity.Keys} keys A set of key(s) that uniquely identify the
     *        entity record in the table.
     * @param {Object} updateProps An object of key value pairs representing the
     *        data to be updated in the record.
     * @param {Object} deleteProps An object of key value pairs representing the
     *        data to be deleted from the record.
     * @param {String} version A value that is used to perform optimistic
     *        locking for concurrent writes.
     * @param {Entity.Audit} [audit={}] Audit information to associate with the
     *        query.
     *
     * @return {Promise} A promise that will be rejected/resolved based on the
     *         outcome of the create operation. If resolved, the data will
     *         contain a list of updated and deleted fields.
     */
    update(keys, updateProps, deleteProps, version, audit) {
        _argValidator.checkObject(keys, 'Invalid keys (arg #1)');
        _argValidator.checkObject(
            updateProps,
            'Invalid update properties (arg #2)'
        );
        _argValidator.checkObject(
            deleteProps,
            'Invalid delete properties (arg #3)'
        );
        _argValidator.checkString(version, 1, 'Invalid version (arg #4)');

        const hashKey = this._getHashKey(keys);
        const rangeKey = this._getRangeKey(keys);
        const username = this._getUsername(audit);
        const logger = this._logger.child({
            operation: 'update',
            username,
            hashKey,
            rangeKey
        });

        logger.trace('Initializing DynamoDB client');
        let client = this._initClient();

        logger.trace('Determining properties to update');
        let propsToUpdate = this._updateCopier.copy(updateProps);
        logger.trace('Update payload', { propsToUpdate });

        logger.trace('Determining properties to delete');
        propsToUpdate = this._deleteCopier.copy(
            deleteProps,
            propsToUpdate,
            (property, value) => client.del()
        );
        logger.trace('Update and delete payload', { propsToUpdate });

        const properties = Object.keys(propsToUpdate);
        logger.info('Properties to be updated', { properties });

        if (properties.length > 0) {
            logger.trace('Adding query conditions to client');
            client = client.where(this.hashKeyName).eq(hashKey);
            if (typeof rangeKey !== 'undefined') {
                client = client.where(this.rangeKeyName).eq(rangeKey);
            }
            client = client.if('__deleted').eq('no');
            client = client.if('__version').eq(version);
            client = client.return(client.ALL_OLD);

            logger.trace('Setting version and audit information');
            propsToUpdate.__version = _shortId.generate();
            propsToUpdate.__updatedBy = username;
            propsToUpdate.__updateDate = Date.now();

            logger.trace('Updating entity record');
            const action = Promise.promisify(
                client.update.bind(client, propsToUpdate)
            );
            return Entity._execQuery(action, logger).then(
                (results) => {
                    return {
                        keys,
                        properties,
                        __version: version
                    };
                },
                (error) => {
                    if (error.code === 'ConditionalCheckFailedException') {
                        logger.error('Conditional check failed on update');
                        throw new ConcurrencyControlError();
                    } else {
                        throw error;
                    }
                }
            );
        } else {
            logger.info('No fields need to be updated or deleted');
            return Promise.try(() => {
                return {
                    keys,
                    properties,
                    __version: version
                };
            });
        }
    }

    /**
     * Deletes an existing entity from the dynamodb table.
     *
     * @param {Entity.Keys} keys A set of key(s) that uniquely identify the
     *        entity record in the table.
     *
     * @return {Promise} A promise that will be rejected/resolved based on the
     *         outcome of the create operation.
     */
    delete(keys) {}
}

module.exports = Entity;
