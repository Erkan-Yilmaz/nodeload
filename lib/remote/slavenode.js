var BUILD_AS_SINGLE_FILE;
if (!BUILD_AS_SINGLE_FILE) {
var url = require('url');
var util = require('../util');
var Endpoint = require('./endpoint').Endpoint;
var EndpointClient = require('./endpointclient').EndpointClient;
var EventEmitter = require('events').EventEmitter;
var NODELOAD_CONFIG = require('../config').NODELOAD_CONFIG;
}

/** An instance of SlaveNode represents a slave from the perspective of a slave (as opposed to 
slave.js#Slave, which represents a slave from the perspective of a master). When a slave.js#Slave object
is started, it sends a slave specification to the target machine, which uses the specification to create
a SlaveNode. The specification contains:

    {
        id: master assigned id of this node,
        master: 'base url of master endpoint, e.g. /remote/0',
        masterMethods: ['list of method name supported by master'],
        slaveMethods: [
            { name: 'method-name', fun: 'function() { valid Javascript in a string }' }
        ],
        updateInterval: milliseconds between sending the current execution state to master
    }

If the any of the slaveMethods contain invalid Javascript, this constructor will throw an exception.

SlaveNode emits the following events:
- 'start': The endpoint has been installed on the HTTP server and connection to the master has been made
- 'end': The local endpoint has been removed and the connection to the master server terminated 
*/
var SlaveNode = exports.SlaveNode = function SlaveNode(server, spec) {
    EventEmitter.call(this);
    util.PeriodicUpdater.call(this);

    this.id = spec.id;

    var endpoint = this.createEndpoint_(server, spec.slaveMethods),
        masterClient = spec.master ? this.createMasterClient_(spec.master, spec.masterMethods) : null;

    this.url = endpoint.url;
    this.masterClient_ = masterClient;
    this.slaveEndpoint_ = endpoint;
    this.slaveEndpoint_.context.state = 'initialized';
    this.slaveEndpoint_.setStaticParams([this.masterClient_]);
    this.slaveEndpoint_.on('start', function() { this.emit.bind(this, 'start'); });
    this.slaveEndpoint_.on('end', this.end.bind(this));
    this.updateInterval = (spec.updateInterval >= 0) ? spec.updateInterval : NODELOAD_CONFIG.SLAVE_UPDATE_INTERVAL_MS;

    this.slaveEndpoint_.start();
};
util.inherits(SlaveNode, EventEmitter);
SlaveNode.prototype.end = function() {
    if (this.slaveEndpoint_.state === 'started') {
        this.slaveEndpoint_.destroy();
    }
    if (this.masterClient_.state === 'connected' || this.masterClient_.state === 'reconnect') {
        this.masterClient_.destroy();
    }
    this.emit('end');
};
SlaveNode.prototype.update = function() {
    if (this.masterClient_ && this.masterClient_.state === 'connected') {
        this.masterClient_.updateSlaveState_(this.slaveEndpoint_.context.state);
    }
};
SlaveNode.prototype.createEndpoint_ = function(server, methods) {
    // Add a new endpoint and route to the HttpServer
    var endpoint = new Endpoint(server);
    
    // "Compile" the methods by eval()'ing the string in "fun", and add to the endpoint
    if (methods) {
        try {
            methods.forEach(function(m) {
                var fun;
                eval('fun=' + m.fun);
                endpoint.defineMethod(m.name, fun);
            });
        } catch (e) {
            endpoint.destroy();
            endpoint = null;
            throw e;
        }
    }
    
    return endpoint;
};
SlaveNode.prototype.createMasterClient_ = function(masterUrl, methods) {
    var parts = url.parse(masterUrl),
        masterClient = new EndpointClient(parts.hostname, Number(parts.port) || 8000, parts.pathname);

    masterClient.defineMethod('updateSlaveState_');
    if (methods && methods instanceof Array) {
        methods.forEach(function(m) { masterClient.defineMethod(m); });
    }

    masterClient.setStaticParams([this.id]);
    
    return masterClient;
};


/** Install the /remote URL handler, which creates a slave endpoint. On receiving a POST request to
/remote, a new route is added to HTTP_SERVER using the handler definition provided in the request body.
See #SlaveNode for a description of the handler defintion. */
var installRemoteHandler = exports.installRemoteHandler = function(server) {
    var slaveNodes = [];
    server.addRoute('^/remote/?$', function(path, req, res) {
        if (req.method === 'POST') {
            util.readStream(req, function(body) {
                var slaveNode;

                // Grab the slave endpoint definition from the HTTP request body; should be valid JSON
                try {
                    body = JSON.parse(body);
                    slaveNode = new SlaveNode(server, body);
                } catch(e) {
                    res.writeHead(400);
                    res.end(e.toString());
                    return;
                }

                slaveNode.on('end', function() {
                    slaveNodes = slaveNodes.filter(function(s) { return s !== slaveNode; });
                });
                slaveNodes.push(slaveNode);
            
                res.writeHead(201, {
                    'Location': slaveNode.url, 
                    'Content-Length': 0,
                });
                res.end();
            });
        } else if (req.method === 'GET') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(slaveNodes.map(function(s) { return s.url; })));
        } else {
            res.writeHead(405);
            res.end();
        }
    });
};