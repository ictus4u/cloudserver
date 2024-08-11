const assert = require('assert');
const async = require('async');
const { storage } = require('arsenal');

const { cleanup, DummyRequestLogger, makeAuthInfo }
    = require('../unit/helpers');
const { bucketPut } = require('../../lib/api/bucketPut');
const objectPut = require('../../lib/api/objectPut');
const DummyRequest = require('../unit/DummyRequest');

const { ds } = storage.data.inMemory.datastore;

const log = new DummyRequestLogger();
const canonicalID = 'accessKey1';
const authInfo = makeAuthInfo(canonicalID);
const namespace = 'default';
const bucketName = 'bucketname';
const body = Buffer.from('I am a body', 'utf8');
const correctMD5 = 'be747eb4b75517bf6b3cf7c5fbb62f3a';
const fileLocation = 'scality-internal-file';
const memLocation = 'scality-internal-mem';
const sproxydLocation = 'scality-internal-sproxyd';

const isCEPH = process.env.CI_CEPH !== undefined;
const describeSkipIfE2E = process.env.S3_END_TO_END ? describe.skip : describe;

function put(bucketLoc, objLoc, requestHost, objectName, cb, errorDescription) {
    const post = bucketLoc ? '<?xml version="1.0" encoding="UTF-8"?>' +
        '<CreateBucketConfiguration ' +
        'xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        `<LocationConstraint>${bucketLoc}</LocationConstraint>` +
        '</CreateBucketConfiguration>' : '';
    const bucketPutReq = new DummyRequest({
        bucketName,
        namespace,
        headers: { host: `${bucketName}.s3.amazonaws.com` },
        url: '/',
        post,
    });
    if (requestHost) {
        bucketPutReq.parsedHost = requestHost;
    }
    const objPutParams = {
        bucketName,
        namespace,
        objectKey: objectName,
        headers: {},
        url: `/${bucketName}/${objectName}`,
        calculatedHash: 'vnR+tLdVF79rPPfF+7YvOg==',
    };
    if (objLoc) {
        objPutParams.headers = {
            'x-amz-meta-scal-location-constraint': `${objLoc}`,
        };
    }
    const testPutObjReq = new DummyRequest(objPutParams, body);
    if (requestHost) {
        testPutObjReq.parsedHost = requestHost;
    }
    bucketPut(authInfo, bucketPutReq, log, () => {
        objectPut(authInfo, testPutObjReq, undefined, log, (err,
            resHeaders) => {
            if (errorDescription) {
                assert.strictEqual(err.code, 400);
                assert(err.is.InvalidArgument);
                assert(err.description.indexOf(errorDescription) > -1);
            } else {
                assert.strictEqual(err, null, `Error putting object: ${err}`);
                assert.strictEqual(resHeaders.ETag, `"${correctMD5}"`);
            }
            cb();
        });
    });
}

describeSkipIfE2E('objectPutAPI with multiple backends', function testSuite() {
    this.timeout(5000);

    const putCases = [
        {
            name: 'mem',
            bucketLoc: fileLocation,
            objLoc: memLocation,
        },
        {
            name: 'file',
            bucketLoc: memLocation,
            objLoc: fileLocation,
        },
        {
            name: 'AWS',
            bucketLoc: memLocation,
            objLoc: 'awsbackend',
        },
        {
            name: 'azure',
            bucketLoc: memLocation,
            objLoc: 'azurebackend',
        },
        {
            name: 'mem based on bucket location',
            bucketLoc: memLocation,
            objLoc: null,
        },
        {
            name: 'file based on bucket location',
            bucketLoc: fileLocation,
            objLoc: null,
        },
        {
            name: 'AWS based on bucket location',
            bucketLoc: 'awsbackend',
            objLoc: null,
        },
        {
            name: 'Azure based on bucket location',
            bucketLoc: 'azurebackend',
            objLoc: null,
        },
        {
            name: 'us-east-1 which is file based on bucket location if no locationConstraint provided',
            bucketLoc: null,
            objLoc: null,
        },
    ];

    if (!isCEPH) {
        putCases.push({
            name: 'sproxyd',
            bucketLoc: sproxydLocation,
            objLoc: null,
        });
    }

    function isDataStoredInMem(testCase) {
        return testCase.objLoc === memLocation
               || (testCase.objLoc === null && testCase.bucketLoc === memLocation);
    }

    function checkPut(testCase) {
        if (isDataStoredInMem(testCase)) {
            assert.deepStrictEqual(ds[ds.length - 1].value, body);
        } else {
            assert.deepStrictEqual(ds, []);
        }
    }

    afterEach(() => {
        cleanup();
    });

    putCases.forEach(testCase => {
        it(`should put an object to ${testCase.name}`, done => {
            async.series([
                next => put(testCase.bucketLoc, testCase.objLoc, 'localhost', 'obj1', next),
                next => {
                    checkPut(testCase);
                    // Increase the probability of the first request having released
                    // the socket, so that it can be reused for the next request.
                    // This tests how HTTP connection reuse behaves.
                    setTimeout(next, 10);
                },
                // Second put should work as well
                next => put(testCase.bucketLoc, testCase.objLoc, 'localhost', 'obj2', next),
                next => {
                    checkPut(testCase);
                    setTimeout(next, 10);
                },
                // Overwriting PUT
                next => put(testCase.bucketLoc, testCase.objLoc, 'localhost', 'obj2', next),
                next => {
                    checkPut(testCase);
                    next();
                },
            ], done);
        });
    });
});
