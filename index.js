var _ = require('underscore');
var AWS = require('aws-sdk');
var moment = require('moment');
var path = require('path');
var async = require('async');

var Uploader = require('s3-streaming-upload').Uploader;

var ReadableStream = require('./readable-stream');

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_DEFAULT_REGION || 'us-east-1'
});

var opts = {};
if (process.env.AWS_DYNAMODB_ENDPOINT){
    opts.endpoint = new AWS.Endpoint(process.env.AWS_DYNAMODB_ENDPOINT);
}

function listTables(callback) {
    var tables = [];
    var ddb = new AWS.DynamoDB();
    function fetchMoreTables(lastTable, done) {
        var params = {};
        if (lastTable) {
            params.ExclusiveStartTableName = lastTable;
        }
        ddb.listTables(params, function(err, data) {
            if (err) {
                console.log('Error listing tables');
                console.log(err);
                process.exit();
            }
            tables = tables.concat(data.TableNames);
            if (data.LastEvaluatedTableName) {
                fetchMoreTables(data.LastEvaluatedTableName, done);
            } else {
                done();
            }
        });
    }
    
    fetchMoreTables(null, function(err) {
        callback(null, tables);
    });
}

function copyTable(tableName, itemsReceived, callback) {
    var ddb = new AWS.DynamoDB(tableName);

    function fetchItems(startKey, limit, itemsReceived, done) {
        var params = {
            Limit: limit,
            ReturnConsumedCapacity: 'NONE',
            TableName: tableName
        };
        if (startKey) {
            params.ExclusiveStartKey = startKey;
        }
        ddb.scan(params, function(err, data) {
            if (err) {
                console.log('Error fetching data');
                console.log(err);
                process.exit();
            }

            if(data.Items.length > 0) {
                itemsReceived(data.Items);
            }

            if (!data.LastEvaluatedKey || _.keys(data.LastEvaluatedKey).length === 0) {
                done();
            } else {
                fetchItems(data.LastEvaluatedKey, limit, itemsReceived, done);
            }
        });
    }

    ddb.describeTable({ TableName: tableName }, function(err, data) {
        if (err) {
            console.log('Error describing table');
            console.log(err);
            process.exit();
        }

        var limit = Math.max((data.Table.ProvisionedThroughput.ReadCapacityUnits * .25)|0, 1);

        fetchItems(null, limit, itemsReceived, callback);
    });
}

function saveTable(tableName, backupPath, callback) {
    var stream = new ReadableStream();

    var uploader = new Uploader({
        // credentials to access AWS
        accessKey:  process.env.AWS_ACCESS_KEY_ID,
        secretKey:  process.env.AWS_SECRET_ACCESS_KEY,
        region:     'us-east-1',
        bucket:     'markitx-backups',
        objectName: path.join(backupPath, tableName + '.json'),
        stream:     stream
    });

    copyTable(tableName,
        function(items) {
            items.forEach(function(item) {
                stream.append(JSON.stringify(item));
                stream.append('\n');
            });
        },
        function() {
            stream.end();
            callback();
        }
    );
}

function backupTables(callback) {
    var now = moment();
    var backupPath = now.format('DynamoDB-backup-YYYY-MM-DD-HH-mm-ss')
    listTables(function(err, tables) {
        async.each(tables,
            function(tableName, done) {
                console.log('Starting to copy table ' + tableName);

                var startTime = moment();
                saveTable(tableName, backupPath, function() {
                    var endTime = moment();
                    console.log('Done copying table ' + tableName + '. Took ' + endTime.diff(startTime, 'minutes', true).toFixed(2) + ' minutes');
                    done();
                });
            },
            function() {
                callback();
            }
        );
    });
}

module.exports = backupTables;

var runningAsScript = require.main === module;

if (runningAsScript) {
    backupTables(function() {
        console.log('Finished backing up DynamoDB');
    });
}