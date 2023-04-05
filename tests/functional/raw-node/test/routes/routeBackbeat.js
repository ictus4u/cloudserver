const assert = require('assert');
const async = require('async');
const crypto = require('crypto');
const { models, versioning } = require('arsenal');
const { ObjectMD } = models;
const versionIdUtils = versioning.VersionID;

const { makeRequest } = require('../../utils/makeRequest');
const BucketUtility = require('../../../aws-node-sdk/lib/utility/bucket-util');

const ipAddress = process.env.IP ? process.env.IP : '127.0.0.1';
const describeSkipIfAWS = process.env.AWS_ON_AIR ? describe.skip : describe;

const backbeatAuthCredentials = {
    accessKey: 'accessKey1',
    secretKey: 'verySecretKey1',
};

const TEST_BUCKET = 'backbeatbucket';
const TEST_ENCRYPTED_BUCKET = 'backbeatbucket-encrypted';
const TEST_KEY = 'fookey';
const NONVERSIONED_BUCKET = 'backbeatbucket-non-versioned';
const BUCKET_FOR_NULL_VERSION = 'backbeatbucket-null-version';

const testArn = 'aws::iam:123456789012:user/bart';
const testKey = 'testkey';
const testKeyUTF8 = '䆩鈁櫨㟔罳';
const testData = 'testkey data';
const testDataMd5 = crypto.createHash('md5')
          .update(testData, 'utf-8')
          .digest('hex');
const emptyContentsMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
const testMd = {
    'md-model-version': 2,
    'owner-display-name': 'Bart',
    'owner-id': ('79a59df900b949e55d96a1e698fbaced' +
                 'fd6e09d98eacf8f8d5218e7cd47ef2be'),
    'last-modified': '2017-05-15T20:32:40.032Z',
    'content-length': testData.length,
    'content-md5': testDataMd5,
    'x-amz-server-version-id': '',
    'x-amz-storage-class': 'STANDARD',
    'x-amz-server-side-encryption': '',
    'x-amz-server-side-encryption-aws-kms-key-id': '',
    'x-amz-server-side-encryption-customer-algorithm': '',
    'location': null,
    'acl': {
        Canned: 'private',
        FULL_CONTROL: [],
        WRITE_ACP: [],
        READ: [],
        READ_ACP: [],
    },
    'nullVersionId': '99999999999999999999RG001  ',
    'isDeleteMarker': false,
    'versionId': '98505119639965999999RG001  ',
    'replicationInfo': {
        status: 'COMPLETED',
        backends: [{ site: 'zenko', status: 'PENDING' }],
        content: ['DATA', 'METADATA'],
        destination: 'arn:aws:s3:::dummy-dest-bucket',
        storageClass: 'STANDARD',
    },
};

function checkObjectData(s3, objectKey, dataValue, done) {
    s3.getObject({
        Bucket: TEST_BUCKET,
        Key: objectKey,
    }, (err, data) => {
        assert.ifError(err);
        assert.strictEqual(data.Body.toString(), dataValue);
        done();
    });
}

function updateStorageClass(data, storageClass) {
    let parsedBody;
    try {
        parsedBody = JSON.parse(data.body);
    } catch (err) {
        return { error: err };
    }
    const { result, error } = ObjectMD.createFromBlob(parsedBody.Body);
    if (error) {
        return { error };
    }
    result.setAmzStorageClass(storageClass);
    return { result };
}

/** makeBackbeatRequest - utility function to generate a request going
 * through backbeat route
 * @param {object} params - params for making request
 * @param {string} params.method - request method
 * @param {string} params.bucket - bucket name
 * @param {string} params.objectKey - object key
 * @param {string} params.subCommand - subcommand to backbeat
 * @param {object} [params.headers] - headers and their string values
 * @param {object} [params.authCredentials] - authentication credentials
 * @param {object} params.authCredentials.accessKey - access key
 * @param {object} params.authCredentials.secretKey - secret key
 * @param {string} [params.requestBody] - request body contents
 * @param {object} [params.queryObj] - query params
 * @param {function} callback - with error and response parameters
 * @return {undefined} - and call callback
 */
function makeBackbeatRequest(params, callback) {
    const { method, headers, bucket, objectKey, resourceType,
            authCredentials, requestBody, queryObj } = params;
    const options = {
        authCredentials,
        hostname: ipAddress,
        port: 8000,
        method,
        headers,
        path: `/_/backbeat/${resourceType}/${bucket}/${objectKey}`,
        requestBody,
        jsonResponse: true,
        queryObj,
    };
    makeRequest(options, callback);
}

function getMetadataToPut(putDataResponse) {
    const mdToPut = Object.assign({}, testMd);
    // Reproduce what backbeat does to update target metadata
    mdToPut.location = JSON.parse(putDataResponse.body);
    ['x-amz-server-side-encryption',
     'x-amz-server-side-encryption-aws-kms-key-id',
     'x-amz-server-side-encryption-customer-algorithm'].forEach(headerName => {
         if (putDataResponse.headers[headerName]) {
             mdToPut[headerName] = putDataResponse.headers[headerName];
         }
     });
    return mdToPut;
}

describeSkipIfAWS('backbeat routes', () => {
    let bucketUtil;
    let s3;

    before(done => {
        bucketUtil = new BucketUtility(
            'default', { signatureVersion: 'v4' });
        s3 = bucketUtil.s3;
        s3.createBucket({ Bucket: TEST_BUCKET }).promise()
            .then(() => s3.putBucketVersioning(
                {
                    Bucket: TEST_BUCKET,
                    VersioningConfiguration: { Status: 'Enabled' },
                }).promise())
            .then(() => s3.createBucket({
                Bucket: NONVERSIONED_BUCKET,
            }).promise())
            .then(() => s3.createBucket({ Bucket: BUCKET_FOR_NULL_VERSION }).promise())
            .then(() => s3.createBucket({ Bucket: TEST_ENCRYPTED_BUCKET }).promise())
            .then(() => s3.putBucketVersioning(
                {
                    Bucket: TEST_ENCRYPTED_BUCKET,
                    VersioningConfiguration: { Status: 'Enabled' },
                }).promise())
            .then(() => s3.putBucketEncryption(
                {
                    Bucket: TEST_ENCRYPTED_BUCKET,
                    ServerSideEncryptionConfiguration: {
                        Rules: [
                            {
                                ApplyServerSideEncryptionByDefault: {
                                    SSEAlgorithm: 'AES256',
                                },
                            },
                        ],
                    },
                }).promise())
            .then(() => done())
            .catch(err => {
                process.stdout.write(`Error creating bucket: ${err}\n`);
                throw err;
            });
    });
    after(done => {
        bucketUtil.empty(TEST_BUCKET)
            .then(() => s3.deleteBucket({ Bucket: TEST_BUCKET }).promise())
            .then(() => bucketUtil.empty(TEST_ENCRYPTED_BUCKET))
            .then(() => s3.deleteBucket({ Bucket: TEST_ENCRYPTED_BUCKET }).promise())
            .then(() =>
                s3.deleteBucket({ Bucket: NONVERSIONED_BUCKET }).promise())
            .then(() => done());
    });

    describe('backbeat PUT routes', () => {
        describe('null version', () => {
            beforeEach(done => s3.createBucket({ Bucket: BUCKET_FOR_NULL_VERSION }, done));
            afterEach(done => {
                bucketUtil.empty(BUCKET_FOR_NULL_VERSION)
                    .then(() => s3.deleteBucket({ Bucket: BUCKET_FOR_NULL_VERSION }).promise())
                    .then(() => done());
            });

            // TO BE TESTED: null version created after version suspended.

            it('should update metadata of a null version created before version enabled', done => {
                const bucket = BUCKET_FOR_NULL_VERSION;
                const keyName = 'key0';
                let objMD;
                const storageClass = 'foo';
                return async.series([
                    next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                    next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                        next),
                    next => makeBackbeatRequest({
                        method: 'GET',
                        resourceType: 'metadata',
                        bucket,
                        objectKey: keyName,
                        queryObj: {
                            versionId: 'null',
                        },
                        authCredentials: backbeatAuthCredentials,
                    }, (err, data) => {
                        if (err) {
                            return next(err);
                        }
                        const { error, result } = updateStorageClass(data, storageClass);
                        if (error) {
                            return next(error);
                        }
                        objMD = result;
                        return next();
                    }),
                    next => makeBackbeatRequest({
                        method: 'PUT',
                        resourceType: 'metadata',
                        bucket,
                        objectKey: keyName,
                        queryObj: {
                            versionId: 'null',
                        },
                        authCredentials: backbeatAuthCredentials,
                        requestBody: objMD.getSerialized(),
                    }, next),
                    next => s3.headObject({ Bucket: bucket, Key: keyName }, next),
                    next => s3.listObjectVersions({ Bucket: bucket }, next),
                ], (err, data) => {
                    if (err) {
                        return done(err);
                    }
                    const headObjectRes = data[4];
                    assert.strictEqual(headObjectRes.VersionId, 'null');
                    assert.strictEqual(headObjectRes.StorageClass, storageClass);

                    const listObjectVersionsRes = data[5];
                    const versions = listObjectVersionsRes.Versions;
                    assert.strictEqual(versions.length, 1);

                    const version = versions[0];
                    assert.strictEqual(version.Key, keyName);
                    assert.strictEqual(version.VersionId, 'null');
                    assert.strictEqual(version.StorageClass, storageClass);
                    return done();
                });
            });

            it('should update metadata of a null version', done => {
                const bucket = BUCKET_FOR_NULL_VERSION;
                const keyName = 'key0';
                let objMD;
                let expectedVersionId;
                const storageClass = 'foo';
                return async.series([
                    next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                    next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                        next),
                    next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                        if (err) {
                            return next(err);
                        }
                        expectedVersionId = data.VersionId;
                        return next();
                    }),
                    next => makeBackbeatRequest({
                        method: 'GET',
                        resourceType: 'metadata',
                        bucket,
                        objectKey: keyName,
                        queryObj: {
                            versionId: 'null',
                        },
                        authCredentials: backbeatAuthCredentials,
                    }, (err, data) => {
                        if (err) {
                            return next(err);
                        }
                        const { error, result } = updateStorageClass(data, storageClass);
                        if (error) {
                            return next(error);
                        }
                        objMD = result;
                        return next();
                    }),
                    next => makeBackbeatRequest({
                        method: 'PUT',
                        resourceType: 'metadata',
                        bucket,
                        objectKey: keyName,
                        queryObj: {
                            versionId: 'null',
                        },
                        authCredentials: backbeatAuthCredentials,
                        requestBody: objMD.getSerialized(),
                    }, next),
                    next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                    next => s3.listObjectVersions({ Bucket: bucket }, next),
                ], (err, data) => {
                    if (err) {
                        return done(err);
                    }
                    const headObjectRes = data[5];
                    assert.strictEqual(headObjectRes.VersionId, 'null');
                    assert.strictEqual(headObjectRes.StorageClass, storageClass);

                    const listObjectVersionsRes = data[6];
                    const versions = listObjectVersionsRes.Versions;
                    assert.strictEqual(versions.length, 2);

                    const latestVersions = versions.filter(v => v.IsLatest);
                    assert.strictEqual(latestVersions.length, 1);
                    const latestVersion = latestVersions[0];
                    assert.strictEqual(latestVersion.Key, keyName);
                    assert.strictEqual(latestVersion.VersionId, expectedVersionId);
                    assert.strictEqual(latestVersion.StorageClass, 'STANDARD');

                    const oldVersions = versions.filter(v => !v.IsLatest);
                    assert.strictEqual(oldVersions.length, 1);
                    const oldVersion = oldVersions[0];
                    assert.strictEqual(oldVersion.Key, keyName);
                    assert.strictEqual(oldVersion.VersionId, 'null');
                    assert.strictEqual(oldVersion.StorageClass, storageClass);
                    return done();
                });
            });
        });

        describe('PUT data + metadata should create a new complete object',
        () => {
            [{
                caption: 'with ascii test key',
                key: testKey, encodedKey: testKey,
            },
            {
                caption: 'with UTF8 key',
                key: testKeyUTF8, encodedKey: encodeURI(testKeyUTF8),
            },
            {
                caption: 'with percents and spaces encoded as \'+\' in key',
                key: '50% full or 50% empty',
                encodedKey: '50%25+full+or+50%25+empty',
            },
            {
                caption: 'with legacy API v1',
                key: testKey, encodedKey: testKey,
                legacyAPI: true,
            },
            {
                caption: 'with encryption configuration',
                key: testKey, encodedKey: testKey,
                encryption: true,
            },
            {
                caption: 'with encryption configuration and legacy API v1',
                key: testKey, encodedKey: testKey,
                encryption: true,
                legacyAPI: true,
            }].concat([
                `${testKeyUTF8}/${testKeyUTF8}/%42/mykey`,
                'Pâtisserie=中文-español-English',
                'notes/spring/1.txt',
                'notes/spring/2.txt',
                'notes/spring/march/1.txt',
                'notes/summer/1.txt',
                'notes/summer/2.txt',
                'notes/summer/august/1.txt',
                'notes/year.txt',
                'notes/yore.rs',
                'notes/zaphod/Beeblebrox.txt',
            ].map(key => ({
                key, encodedKey: encodeURI(key),
                caption: `with key ${key}`,
            })))
            .forEach(testCase => {
                it(testCase.caption, done => {
                    async.waterfall([next => {
                        const queryObj = testCase.legacyAPI ? {} : { v2: '' };
                        makeBackbeatRequest({
                            method: 'PUT', bucket: testCase.encryption ?
                                TEST_ENCRYPTED_BUCKET : TEST_BUCKET,
                            objectKey: testCase.encodedKey,
                            resourceType: 'data',
                            queryObj,
                            headers: {
                                'content-length': testData.length,
                                'content-md5': testDataMd5,
                                'x-scal-canonical-id': testArn,
                            },
                            authCredentials: backbeatAuthCredentials,
                            requestBody: testData }, next);
                    }, (response, next) => {
                        assert.strictEqual(response.statusCode, 200);
                        const newMd = getMetadataToPut(response);
                        if (testCase.encryption && !testCase.legacyAPI) {
                            assert.strictEqual(typeof newMd.location[0].cryptoScheme, 'number');
                            assert.strictEqual(typeof newMd.location[0].cipheredDataKey, 'string');
                        } else {
                            // if no encryption or legacy API, data should not be encrypted
                            assert.strictEqual(newMd.location[0].cryptoScheme, undefined);
                            assert.strictEqual(newMd.location[0].cipheredDataKey, undefined);
                        }
                        makeBackbeatRequest({
                            method: 'PUT', bucket: testCase.encryption ?
                                TEST_ENCRYPTED_BUCKET : TEST_BUCKET,
                            objectKey: testCase.encodedKey,
                            resourceType: 'metadata',
                            queryObj: {
                                versionId: versionIdUtils.encode(
                                    testMd.versionId),
                            },
                            authCredentials: backbeatAuthCredentials,
                            requestBody: JSON.stringify(newMd),
                        }, next);
                    }, (response, next) => {
                        assert.strictEqual(response.statusCode, 200);
                        s3.getObject({
                            Bucket: testCase.encryption ?
                                TEST_ENCRYPTED_BUCKET : TEST_BUCKET,
                            Key: testCase.key,
                        }, (err, data) => {
                            assert.ifError(err);
                            assert.strictEqual(data.Body.toString(), testData);
                            next();
                        });
                    }], err => {
                        assert.ifError(err);
                        done();
                    });
                });
            });
        });

        it('PUT metadata with "x-scal-replication-content: METADATA"' +
        'header should replicate metadata only', done => {
            async.waterfall([next => {
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_ENCRYPTED_BUCKET,
                    objectKey: 'test-updatemd-key',
                    resourceType: 'data',
                    queryObj: { v2: '' },
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData,
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const newMd = getMetadataToPut(response);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_ENCRYPTED_BUCKET,
                    objectKey: 'test-updatemd-key',
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // Don't update the sent metadata since it is sent by
                // backbeat as received from the replication queue,
                // without updated data location or encryption info
                // (since that info is not known by backbeat)
                const newMd = Object.assign({}, testMd);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_ENCRYPTED_BUCKET,
                    objectKey: 'test-updatemd-key',
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    headers: { 'x-scal-replication-content': 'METADATA' },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                s3.getObject({
                    Bucket: TEST_ENCRYPTED_BUCKET,
                    Key: 'test-updatemd-key',
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should refuse PUT data if bucket is not versioned',
        done => makeBackbeatRequest({
            method: 'PUT', bucket: NONVERSIONED_BUCKET,
            objectKey: testKey, resourceType: 'data',
            queryObj: { v2: '' },
            headers: {
                'content-length': testData.length,
                'content-md5': testDataMd5,
                'x-scal-canonical-id': testArn,
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: testData,
        },
        err => {
            assert.strictEqual(err.code, 'InvalidBucketState');
            done();
        }));

        it('should refuse PUT metadata if bucket is not versioned',
        done => makeBackbeatRequest({
            method: 'PUT', bucket: NONVERSIONED_BUCKET,
            objectKey: testKey, resourceType: 'metadata',
            queryObj: {
                versionId: versionIdUtils.encode(testMd.versionId),
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: JSON.stringify(testMd),
        },
        err => {
            assert.strictEqual(err.code, 'InvalidBucketState');
            done();
        }));

        it('should refuse PUT data if no x-scal-canonical-id header ' +
           'is provided', done => makeBackbeatRequest({
               method: 'PUT', bucket: TEST_BUCKET,
               objectKey: testKey, resourceType: 'data',
               queryObj: { v2: '' },
               headers: {
                   'content-length': testData.length,
                   'content-md5': testDataMd5,
               },
               authCredentials: backbeatAuthCredentials,
               requestBody: testData,
           },
           err => {
               assert.strictEqual(err.code, 'BadRequest');
               done();
           }));

        it('should refuse PUT data if no content-md5 header is provided',
        done => makeBackbeatRequest({
            method: 'PUT', bucket: TEST_BUCKET,
            objectKey: testKey, resourceType: 'data',
            queryObj: { v2: '' },
            headers: {
                'content-length': testData.length,
                'x-scal-canonical-id': testArn,
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: testData,
        },
        err => {
            assert.strictEqual(err.code, 'BadRequest');
            done();
        }));

        it('should refuse PUT in metadata-only mode if object does not exist',
        done => {
            async.waterfall([next => {
                const newMd = Object.assign({}, testMd);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: 'does-not-exist',
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    headers: { 'x-scal-replication-content': 'METADATA' },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }], err => {
                assert.strictEqual(err.statusCode, 404);
                done();
            });
        });

        it('should remove old object data locations if version is overwritten ' +
        'with same contents', done => {
            let oldLocation;
            const testKeyOldData = `${testKey}-old-data`;
            async.waterfall([next => {
                // put object's data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put object metadata
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                oldLocation = newMd.location;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put another object which metadata reference the
                // same data locations, we will attempt to retrieve
                // this object at the end of the test to confirm that
                // its locations have been deleted
                const oldDataMd = Object.assign({}, testMd);
                oldDataMd.location = oldLocation;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKeyOldData,
                    resourceType: 'metadata',
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(oldDataMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // create new data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // overwrite the original object version, now
                // with references to the new data locations
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // give some time for the async deletes to complete
                setTimeout(() => checkObjectData(s3, testKey, testData, next),
                           1000);
            }, next => {
                // check that the object copy referencing the old data
                // locations is unreadable, confirming that the old
                // data locations have been deleted
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKeyOldData,
                }, err => {
                    assert(err, 'expected error to get object with old data ' +
                           'locations, got success');
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should remove old object data locations if version is overwritten ' +
        'with empty contents', done => {
            let oldLocation;
            const testKeyOldData = `${testKey}-old-data`;
            async.waterfall([next => {
                // put object's data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put object metadata
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                oldLocation = newMd.location;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put another object which metadata reference the
                // same data locations, we will attempt to retrieve
                // this object at the end of the test to confirm that
                // its locations have been deleted
                const oldDataMd = Object.assign({}, testMd);
                oldDataMd.location = oldLocation;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKeyOldData,
                    resourceType: 'metadata',
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(oldDataMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // overwrite the original object version with an empty location
                const newMd = Object.assign({}, testMd);
                newMd['content-length'] = 0;
                newMd['content-md5'] = emptyContentsMd5;
                newMd.location = null;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // give some time for the async deletes to complete
                setTimeout(() => checkObjectData(s3, testKey, '', next),
                           1000);
            }, next => {
                // check that the object copy referencing the old data
                // locations is unreadable, confirming that the old
                // data locations have been deleted
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKeyOldData,
                }, err => {
                    assert(err, 'expected error to get object with old data ' +
                           'locations, got success');
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should not remove data locations on replayed metadata PUT',
        done => {
            let serializedNewMd;
            async.waterfall([next => {
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                serializedNewMd = JSON.stringify(newMd);
                async.timesSeries(2, (i, putDone) => makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: serializedNewMd,
                }, (err, response) => {
                    assert.ifError(err);
                    assert.strictEqual(response.statusCode, 200);
                    putDone(err);
                }), () => next());
            }, next => {
                // check that the object is still readable to make
                // sure we did not remove the data keys
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKey,
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should create a new version when no versionId is passed in query string', done => {
            let newVersion;
            async.waterfall([next => {
                // put object's data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put object metadata
                const oldMd = Object.assign({}, testMd);
                oldMd.location = JSON.parse(response.body);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(oldMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const parsedResponse = JSON.parse(response.body);
                assert.strictEqual(parsedResponse.versionId, testMd.versionId);
                // create new data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'content-md5': testDataMd5,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // create a new version with the new data locations,
                // not passing 'versionId' in the query string
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const parsedResponse = JSON.parse(response.body);
                newVersion = parsedResponse.versionId;
                assert.notStrictEqual(newVersion, testMd.versionId);
                // give some time for the async deletes to complete,
                // then check that we can read the latest version
                setTimeout(() => s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKey,
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                }), 1000);
            }, next => {
                // check that the previous object version is still readable
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKey,
                    VersionId: versionIdUtils.encode(testMd.versionId),
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });
    });
    describe('backbeat authorization checks', () => {
        [{ method: 'PUT', resourceType: 'metadata' },
         { method: 'PUT', resourceType: 'data' }].forEach(test => {
             const queryObj = test.resourceType === 'data' ? { v2: '' } : {};
             it(`${test.method} ${test.resourceType} should respond with ` +
             '403 Forbidden if no credentials are provided',
             done => {
                 makeBackbeatRequest({
                     method: test.method, bucket: TEST_BUCKET,
                     objectKey: TEST_KEY, resourceType: test.resourceType,
                     queryObj,
                 },
                 err => {
                     assert(err);
                     assert.strictEqual(err.statusCode, 403);
                     assert.strictEqual(err.code, 'AccessDenied');
                     done();
                 });
             });
             it(`${test.method} ${test.resourceType} should respond with ` +
                '403 Forbidden if wrong credentials are provided',
                done => {
                    makeBackbeatRequest({
                        method: test.method, bucket: TEST_BUCKET,
                        objectKey: TEST_KEY, resourceType: test.resourceType,
                        queryObj,
                        authCredentials: {
                            accessKey: 'wrong',
                            secretKey: 'still wrong',
                        },
                    },
                    err => {
                        assert(err);
                        assert.strictEqual(err.statusCode, 403);
                        assert.strictEqual(err.code, 'InvalidAccessKeyId');
                        done();
                    });
                });
             it(`${test.method} ${test.resourceType} should respond with ` +
                '403 Forbidden if the account does not match the ' +
                'backbeat user',
                done => {
                    makeBackbeatRequest({
                        method: test.method, bucket: TEST_BUCKET,
                        objectKey: TEST_KEY, resourceType: test.resourceType,
                        queryObj,
                        authCredentials: {
                            accessKey: 'accessKey2',
                            secretKey: 'verySecretKey2',
                        },
                    },
                    err => {
                        assert(err);
                        assert.strictEqual(err.statusCode, 403);
                        assert.strictEqual(err.code, 'AccessDenied');
                        done();
                    });
                });
             it(`${test.method} ${test.resourceType} should respond with ` +
                '403 Forbidden if backbeat user has wrong secret key',
                done => {
                    makeBackbeatRequest({
                        method: test.method, bucket: TEST_BUCKET,
                        objectKey: TEST_KEY, resourceType: test.resourceType,
                        queryObj,
                        authCredentials: {
                            accessKey: backbeatAuthCredentials.accessKey,
                            secretKey: 'hastalavista',
                        },
                    },
                    err => {
                        assert(err);
                        assert.strictEqual(err.statusCode, 403);
                        assert.strictEqual(err.code, 'SignatureDoesNotMatch');
                        done();
                    });
                });
         });
    });

    describe('GET Metadata route', () => {
        beforeEach(done => makeBackbeatRequest({
            method: 'PUT', bucket: TEST_BUCKET,
            objectKey: TEST_KEY,
            resourceType: 'metadata',
            queryObj: {
                versionId: versionIdUtils.encode(testMd.versionId),
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: JSON.stringify(testMd),
        }, done));

        it('should return metadata blob for a versionId', done => {
            makeBackbeatRequest({
                method: 'GET', bucket: TEST_BUCKET,
                objectKey: TEST_KEY, resourceType: 'metadata',
                authCredentials: backbeatAuthCredentials,
                queryObj: {
                    versionId: versionIdUtils.encode(testMd.versionId),
                },
            }, (err, data) => {
                const parsedBody = JSON.parse(JSON.parse(data.body).Body);
                assert.strictEqual(data.statusCode, 200);
                assert.deepStrictEqual(parsedBody, testMd);
                done();
            });
        });

        it('should return error if bucket does not exist', done => {
            makeBackbeatRequest({
                method: 'GET', bucket: 'blah',
                objectKey: TEST_KEY, resourceType: 'metadata',
                authCredentials: backbeatAuthCredentials,
                queryObj: {
                    versionId: versionIdUtils.encode(testMd.versionId),
                },
            }, (err, data) => {
                assert.strictEqual(data.statusCode, 404);
                assert.strictEqual(JSON.parse(data.body).code, 'NoSuchBucket');
                done();
            });
        });

        it('should return error if object does not exist', done => {
            makeBackbeatRequest({
                method: 'GET', bucket: TEST_BUCKET,
                objectKey: 'blah', resourceType: 'metadata',
                authCredentials: backbeatAuthCredentials,
                queryObj: {
                    versionId: versionIdUtils.encode(testMd.versionId),
                },
            }, (err, data) => {
                assert.strictEqual(data.statusCode, 404);
                assert.strictEqual(JSON.parse(data.body).code, 'ObjNotFound');
                done();
            });
        });
    });
    describe('Batch Delete Route', () => {
        it('should batch delete a location', done => {
            let versionId;
            let location;

            async.series([
                done => s3.putObject({
                    Bucket: TEST_BUCKET,
                    Key: 'batch-delete-test-key',
                    Body: new Buffer('hello'),
                }, done),
                done => s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: 'batch-delete-test-key',
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), 'hello');
                    versionId = data.VersionId;
                    done();
                }),
                done => {
                    makeBackbeatRequest({
                        method: 'GET', bucket: TEST_BUCKET,
                        objectKey: 'batch-delete-test-key',
                        resourceType: 'metadata',
                        authCredentials: backbeatAuthCredentials,
                        queryObj: {
                            versionId,
                        },
                    }, (err, data) => {
                        assert.ifError(err);
                        assert.strictEqual(data.statusCode, 200);
                        const metadata = JSON.parse(
                            JSON.parse(data.body).Body);
                        location = metadata.location;
                        done();
                    });
                },
                done => {
                    const options = {
                        authCredentials: backbeatAuthCredentials,
                        hostname: ipAddress,
                        port: 8000,
                        method: 'POST',
                        path: '/_/backbeat/batchdelete',
                        requestBody:
                        `{"Locations":${JSON.stringify(location)}}`,
                        jsonResponse: true,
                    };
                    makeRequest(options, done);
                },
                done => s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: 'batch-delete-test-key',
                }, err => {
                    // should error out as location shall no longer exist
                    assert(err);
                    done();
                }),
            ], done);
        });
        it('should fail with error if given malformed JSON', done => {
            async.series([
                done => {
                    const options = {
                        authCredentials: backbeatAuthCredentials,
                        hostname: ipAddress,
                        port: 8000,
                        method: 'POST',
                        path: '/_/backbeat/batchdelete',
                        requestBody: 'NOTJSON',
                        jsonResponse: true,
                    };
                    makeRequest(options, done);
                },
            ], err => {
                assert(err);
                done();
            });
        });
        it('should skip batch delete of a non-existent location', done => {
            async.series([
                done => {
                    const options = {
                        authCredentials: backbeatAuthCredentials,
                        hostname: ipAddress,
                        port: 8000,
                        method: 'POST',
                        path: '/_/backbeat/batchdelete',
                        requestBody:
                        '{"Locations":' +
                            '[{"key":"abcdef","dataStoreName":"us-east-1"}]}',
                        jsonResponse: true,
                    };
                    makeRequest(options, done);
                },
            ], done);
        });
    });
});
