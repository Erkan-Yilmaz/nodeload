// ------------------------------------
// Main HTTP load testing interface
// ------------------------------------
//
// This file defines run() and traceableRequest().
//
// This file defines the public API for using nodeload to construct load tests. Nodeload modules,
// such as monitoring.js and reporting.js can also be used independently.
//
/*jslint laxbreak: true */
var BUILD_AS_SINGLE_FILE;
if (BUILD_AS_SINGLE_FILE === undefined) {
var START = new Date();
var http = require('http');
var util = require('./util');
var stats = require('./stats');
var reporting = require('./reporting');
var qputs = util.qputs;
var qprint = util.qprint;
var EventEmitter = require('events').EventEmitter;
var PeriodicUpdater = util.PeriodicUpdater;
var MultiLoop = require('./loop').MultiLoop;
var Monitor = require('./monitoring').Monitor;
var Report = reporting.Report;
var LogFile = stats.LogFile;

var NODELOAD_CONFIG = require('./config').NODELOAD_CONFIG;
var REPORT_MANAGER = reporting.REPORT_MANAGER;
var HTTP_SERVER = require('./http').HTTP_SERVER;
}

/** TEST_DEFAULTS defines all of the parameters that can be set in a test specifiction passed to
run(). By default, a test will GET localhost:8080/ as fast as possible with 10 users for 2 minutes. */
var TEST_DEFAULTS = {
    name: 'Debug test',                     // A descriptive name for the test

                                            // Specify one of:
    host: 'localhost',                      //   1. (host, port) to connect to via HTTP
    port: 8080,                             //
                                            //
    connectionGenerator: null,              //   2. connectionGenerator(), called once for each user. 
                                            //      The return value is passed as-is to requestGenerator,
                                            //      requestLoop, or used internally to generate requests
                                            //      when using (method + path + requestData).
                                            
                                            // Specify one of:
    requestGenerator: null,                 //   1. requestGenerator: a function
                                            //         function(http.Client) ->  http.ClientRequest
    requestLoop: null,                      //   2. requestLoop: is a function
                                            //         function(loopFun, http.Client)
    method: 'GET',                          //     If must call:
    path: '/',                              //         loopFun({
    requestData: null,                      //             req: http.ClientRequest, 
                                            //             res: http.ClientResponse});
                                            //     after each transaction to finishes to schedule the 
                                            //     next iteration of requestLoop.
                                            //   3. (method + path + requestData) specify a single URL to
                                            //     test
                                            //
    
                                            // Specify one of:
    numUsers: 10,                           //   1. numUsers: number of virtual users concurrently
                                            //      executing therequest loop
    loadProfile: null,                      //   2. loadProfile: array with requests/sec over time:
                                            //        [[time (seconds), rps], [time 2, rps], ...]
                                            //      For example, ramp up from 100 to 500 rps and then
                                            //      down to 0 over 20 seconds:
                                            //        [[0, 100], [10, 500], [20, 0]]
                                            
                                            // Specify one of:
    targetRps: Infinity,                    //   1. targetRps: times per second to execute request loop
    userProfile: null,                      //   2. userProfile: array with number of users over time:
                                            //        [[time (seconds), # users], [time 2, users], ...]
                                            //      For example, ramp up from 0 to 100 users and back
                                            //      down to 0 over 20 seconds:
                                            //        [[0, 0], [10, 100], [20, 0]]

    numRequests: Infinity,                  // Maximum number of iterations of request loop
    timeLimit: 120,                         // Maximum duration of test in seconds
    delay: 0,                               // Seconds before starting test

    stats: ['latency',                      // Specify list of: 'latency', 'result-codes', 'uniques', 
            'result-codes'],                // 'concurrency', 'http-errors'. These following statistics
                                            // may also be specified with parameters:
                                            //
                                            //     { name: 'latency', percentiles: [0.9, 0.99] }
                                            //     { name: 'http-errors', successCodes: [200,404], log: 'http-errors.log' }
                                            //
                                            // Extend this list of statistics by adding to the
                                            // monitor.js#Monitor.Monitors object.
                                            //
                                            // Note:
                                            // - for 'uniques', traceableRequest() must be used
                                            //   to create the ClientRequest or only 2 will be detected.
};

var LoadTest, createClient, requestGeneratorLoop;

/** run(spec, ...) is the primary method for creating and executing load tests with nodeload. Each spec
can be a test specification or a ramp specification. See TEST_DEFAULTS for a list of the configuration
values in a test specification and RAMP_DEFAULTS in a ramp specification.

@return A test object:

            {
                spec: the spec passed to addTest() to create this test
                stats: { 
                    'latency': Reportable(Histogram), 
                    'result-codes': Reportable(ResultsCounter}, 
                    'uniques': Reportable(Uniques), 
                    'concurrency': Reportable(Peak)
                }
                jobs: jobs scheduled in SCHEDULER for this test
                fun: the function being run by each job in jobs 
            }

        This object emits these events:
        - 'update', stats since last update, overall stats: set the frequency of these events using setWindowSizeSeconds().
        - 'end': all tests finished
*/
var run = exports.run = function(specs) {
    specs = (specs instanceof Array) ? specs : util.argarray(arguments);
    var tests = specs.map(function(spec) {
        var generateConnection = function() {
                return createClient(spec.port, spec.host);
            },
            generateRequest = function(client) {
                if (spec.requestGenerator) { return spec.requestGenerator(client); }
                var request = client.request(spec.method, spec.path, { 'host': spec.host });
                request.end(spec.requestData);
                return request;
            },
            loop = new MultiLoop({
                fun: spec.requestLoop || requestGeneratorLoop(generateRequest),
                argGenerator: spec.connectionGenerator || generateConnection,
                concurrencyProfile: spec.userProfile || [[0, spec.numUsers]],
                rpsProfile: spec.loadProfile || [[0, spec.targetRps]],
                duration: spec.timeLimit,
                numberOfTimes: spec.numRequests,
                delay: spec.delay
            }),
            monitor = new Monitor(spec.stats),
            report = new Report(spec.name).updateFromMonitor(monitor);

        loop.on('add', function(loops) { 
            monitor.monitorObjects(loops, 'startiteration', 'enditeration');
        });
        REPORT_MANAGER.addReport(report);
        
        return {
            spec: spec,
            loop: loop,
            monitor: monitor,
            report: report,
        };
    });
    
    var loadtest = new LoadTest(tests).start();
    loadtest.updateInterval = 2000;
    return loadtest;
};

var LoadTest = exports.LoadTest = function LoadTest(tests) {
    EventEmitter.call(this);
    PeriodicUpdater.call(this);
    
    var self = this;
    self.tests = tests;
    self.interval = {};
    self.stats = {};
    self.tests.forEach(function(test) {
        self.interval[test.spec.name] = test.monitor.interval;
        self.stats[test.spec.name] = test.monitor.stats;
    });
    self.finishChecker_ = this.checkFinished_.bind(this);
};

util.inherits(LoadTest, EventEmitter);

LoadTest.prototype.start = function(keepAliveAfterDone) {
    var self = this;
    self.keepAliveAfterDone_ = keepAliveAfterDone;

    // clients can catch 'start' event even after calling start().
    process.nextTick(self.emit.bind(self, 'start'));
    self.tests.forEach(function(test) {
        test.loop.start();
        test.loop.on('end', self.finishChecker_);
    });
    
    if (!HTTP_SERVER.running && NODELOAD_CONFIG.HTTP_ENABLED) {
        HTTP_SERVER.start(NODELOAD_CONFIG.HTTP_PORT);
    }

    return self;
};

LoadTest.prototype.stop = function() {
    this.tests.forEach(function(t) { t.loop.stop(); });
    return this;
};

LoadTest.prototype.update = function() {
    this.emit('update', this.interval, this.stats);
    this.tests.forEach(function(t) { t.monitor.update(); });
    qprint('.');
};

LoadTest.prototype.checkFinished_ = function() {
    if (this.tests.some(function(t) { return t.loop.running; })) { return; }

    this.updateInterval = 0;
    qputs('Done.');

    if (!this.keepAliveAfterDone_) { 
        HTTP_SERVER.stop();
    }

    this.emit('end');
};

/** extendClient extends an existing instance of http.Client by noting the request method and path.
Writing to new requests also emits the 'write' event. This client must be used when using nodeload to
when tracking 'uniques' and 'request-bytes'. */
var extendClient = exports.extendClient = function(client) {
    var wrappedRequest = client.request;
    client.request = function(method, url) {
        var request = wrappedRequest.apply(client, arguments),
            wrappedWrite = request.write,
            wrappedEnd = request.end,
            track = function(data) {
                if (data) {
                    request.emit('write', data);
                    request.body += data.toString();
                }
            };
        request.method = method;
        request.path = url;
        request.body = '';
        request.write = function(data, encoding) {
            track(data);
            return wrappedWrite.apply(request, arguments);
        };
        request.end = function(data, encoding) {
            track(data);
            return wrappedEnd.apply(request, arguments);
        };
        return request;
    };
    return client;
};

/** Same arguments as http.createClient. Returns an extended version of the object (see extendClient) */
var createClient = function() {
    var client = http.createClient.apply(this, arguments);
    return extendClient(client);
};

/** Wrapper for request generator function, generator

@param generator A function:

                     function(http.Client) -> http.ClientRequest

                 The http.Client is provided by nodeload. The http.ClientRequest may contain an extra
                 .timeout field specifying the maximum milliseconds to wait for a response.

@return A Loop compatible function, function(loopFun, http.Client). Each iteration makes an HTTP
        request by calling generator. loopFun({req: http.ClientRequest, res: http.ClientResponse}) is
        called when the HTTP response is received or the request times out. */
function requestGeneratorLoop(generator) {
    return function(finished, client) {
        var running = true, timeoutId, request = generator(client);
        if (request) {
            if (request.timeout > 0) {
                timeoutId = setTimeout(function() {
                                running = false;
                                finished({req: request, res: {statusCode: 0}});
                            }, request.timeout);
            }
            request.on('response', function(response) {
                if (running) { 
                    clearTimeout(timeoutId);
                    finished({req: request, res: response});
                }
            });
            request.end();
        } else {
            finished(null);
        }
    };
}