const express = require('express');
const socketio = require('socket.io');
const _ = require('lodash');
const uuid = require('uuid');
const Redis = require('ioredis');
const redisutils = require('./library/redisutils')
const RedisInstance = require('./library/redisinstance')
const actions = require('./library/actions');
const monitoractions = require('./library/monitoractions');


const port = process.env.PORT || 3003;
const env = process.env.NODE_ENV || "development";

const app = express();

app.set('port', port);
app.set('env', env);

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});


const router = express.Router();              

// TODO: Serve Angular APP
router.get('/', (req, res) => {
    res.json({ health: 'OK', ...db });
});

app.use('/', router);

const server = app.listen(app.get('port'), () => {
    console.log('Rediseph server listening on port ' + app.get('port'));
});

const io = socketio(server, {'origins': '*:*'} );

const db = {
    redisInstances: [],
};



io.on('connection', (client) => {

    client.on(actions.CONNECT_REDIS_INSTANCE, async (connectionInfo) => {

        let roomId = uuid();
        connectionInfo.id = roomId;
        const cachedRedis = db.redisInstances.find(p=>p.roomId == roomId);
        if(cachedRedis) {
            client.join(roomId);
            client.emit(actions.CONNECT_REDIS_INSTANCE_SUCCESS,
                {redisInfo: connectionInfo, redisTree: cachedRedis.redisScanTree, serverInfo: cachedRedis.redis.serverInfo})
        } else {
            const redis = new Redis({
                host: connectionInfo.ip, port: connectionInfo.port, db: connectionInfo.db,
                password: connectionInfo.password,
                retryStrategy: (times) => {
                    var delay = Math.min(times * 50, 3000);
                    return delay;
                }
            });
            
            redis.on('error', async (e) => {           
                client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                    {redisInfo: connectionInfo, error: 'Cannot connect redis instance!'})
                redis.disconnect();
            });
            redis.once('end', async ()=> {                
                io.to(roomId).emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                    {redisInfo: connectionInfo, error: 'Connection end with redis instance!'})
            })
          
            redis.on('ready', async () => {
                const version = redis.serverInfo.redis_version;
                if(version) {
                    const versionNo = parseInt(version[0]+version[2]);
                    if(versionNo < 28) {                    
                        redis.disconnect();
                        client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                            {
                                error:'This tool works with redis versions >= 2.8.X Yours is ' + version,
                                redisInfo: connectionInfo,
                            })
                            return;
                    }
                }
                const redisInstance = new RedisInstance(roomId, connectionInfo,redis);
                // We stop real-time data from monitor, we need to track local changes.
                redisInstance.cmdStreamer.subscribe(async (actions) => {
                    if (redisInstance.isMonitoring) 
                        return;
                    const ioActions = await redisutils.handleCmdOutputActions(redisInstance,actions);
                    redisInstance.ioStreamer.next(ioActions);
                })
                redisInstance.ioStreamer.subscribe(async (acts)=> {
                    for (let i = 0; i < acts.length; i++) {
                        const action = acts[i];
                        switch (action.type) {
                            case monitoractions.UPDATE_LOCAL_TREE:
                            {
                                io.to(redisInstance.roomId).emit(actions.REDIS_INSTANCE_UPDATED,
                                {
                                    redisInfo: redisInstance.connectionInfo,
                                    isMonitoring: redisInstance.isMonitoring,
                                    keyInfo:redisInstance.keyInfo,
                                    keys: redisInstance.keys,
                                    serverInfo: redisInstance.redis.serverInfo
                                });
                                break; 
                            }                                     
                            default:
                                break;
                        }
                    }
                })
                // first scan when connected
                redisutils.scanRedisTree(redisInstance,
                    redisInstance.keyInfo.cursor,
                    redisInstance.keyInfo.pattern,
                    redisInstance.keyInfo.pageSize,
                    async (keys, cursor) => {
                        redisInstance.keys = keys;
                        redisInstance.keyInfo.cursor = cursor;
                        redisInstance.keyInfo.pageIndex++;
                        redisInstance.keyInfo.hasMoreKeys = cursor !== "0";                      
                        db.redisInstances.push(redisInstance)
                        client.join(roomId)
                        client.emit(actions.CONNECT_REDIS_INSTANCE_SUCCESS,
                            {
                                redisInfo: connectionInfo,
                                isMonitoring: redisInstance.isMonitoring,
                                keyInfo:redisInstance.keyInfo,
                                keys: keys,
                                serverInfo: redis.serverInfo
                            })
                });
            });
        }        
    });

    client.on(actions.WATCH_CHANGES, async (data) => {
        const redisInstance = db.redisInstances.find(p=>p.roomId == data.redisId)
        redisInstance.isMonitoring = true;
        // We stop real-time data from monitor, we need to track local changes.
        redisInstance.redis.monitor(async (err, monitor) => {
            redisInstance.monitor = monitor;
            monitor.on('monitor', async (time, args, source, database) => {
                console.log("monitoring")
                redisutils.handleMonitorCommand(redisInstance, args, async (acts) => {
                    redisInstance.ioStreamer.next(acts);
                });
            });
        });
        
        io.to(data.redisId).emit(actions.WATCHING_CHANGES,data.redisId)
    });

    client.on(actions.STOP_WATCH_CHANGES, async (data) => {
        
        const redisInstance = db.redisInstances.find(p=>p.roomId == data.redisId)
        if(redisInstance.isMonitoring) {
            if(redisInstance.monitor) {
                redisInstance.isMonitoring = false;
                redisInstance.monitor.disconnect();
                delete redisInstance.monitor;
            }
        }
        // We stop real-time data from monitor, we need to track local changes.
        redisInstance.cmdStreamer.subscribe(async (actions) => {
            if(redisInstance.isMonitoring) {
                console.log("Already Monitoring")
                return;
            }
            const ioActions = await redisutils.handleCmdOutputActions(redisInstance,actions);
            redisInstance.ioStreamer.next(ioActions);
        })
        io.to(data.redisId).emit(actions.STOPPED_WATCH_CHANGES, data.redisId)
    });

    client.on(actions.EXECUTE_COMMAND, async (data) => {
        const redisInstance = db.redisInstances.find(p=>p.roomId == data.redisId);
        if (!redisInstance) {
            client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                {error: 'This should not happen!'})
        }
        await redisutils.handleCommandExecution(redisInstance, data.args, (nextActions) => {
            // if it is not monitoring we should take care of it
            if(!redisInstance.isMonitoring) {
                console.log("Exe CB")
                redisInstance.cmdStreamer.next(nextActions);
            }
        })
    });
    client.on(actions.SET_SEARCH_QUERY, async (data) => {
        const redisInstance = db.redisInstances.find(p=>p.roomId == data.redisInstanceId);
        if (!redisInstance) {
            client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                {error: 'This should not happen!'})
        }
        redisInstance.keyInfo = {
            selectedKey: null,
            pattern: data.pattern,
            hasMoreKeys: false,
            cursor: "0",
            pageIndex: 0,
            previousCursors:[],
            pageSize: process.env.SCAN_PAGE_SIZE || 40
        };
        // first scan when search query changes
        redisutils.scanRedisTree(redisInstance,
            redisInstance.keyInfo.cursor,
            redisInstance.keyInfo.pattern,
            redisInstance.keyInfo.pageSize,
            async (keys, cursor) => {
                redisInstance.keys = keys;
                redisInstance.keyInfo.cursor = cursor;
                redisInstance.keyInfo.pageIndex++;
                redisInstance.keyInfo.hasMoreKeys = cursor !== "0";
                
                redisInstance.ioStreamer.next([{type: monitoractions.UPDATE_LOCAL_TREE}]);
        })
    });

    client.on(actions.ITER_NEXT_PAGE_SCAN, async (data) => {
        const redisInstance = db.redisInstances.find(p=>p.roomId == data.redisId);
        if (!redisInstance) {
            client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                {error: 'This should not happen!'})
        }
        // In case of refresh (Maybe after user start monitoring)
        redisInstance.keyInfo.previousCursors.push(redisInstance.keyInfo.cursor);  
        // iter from current cursor with pagesize
        redisutils.scanRedisTree(redisInstance,
            redisInstance.keyInfo.cursor,
            redisInstance.keyInfo.pattern,
            redisInstance.keyInfo.pageSize,
            async (keys, cursor) => {
                redisInstance.keys = Object.assign(redisInstance.keys,keys);
                redisInstance.keyInfo.cursor = cursor;
                redisInstance.keyInfo.pageIndex++;
                redisInstance.keyInfo.hasMoreKeys = cursor !== "0";
                redisInstance.ioStreamer.next([{type: monitoractions.UPDATE_LOCAL_TREE}])                
        })
    });
    client.on(actions.REFRESH_LOADED_KEYS, async (data) => {
        const redisInstance = db.redisInstances.find(p=>p.roomId == data.redisId);
        if (!redisInstance) {
            client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                {error: 'This should not happen!'})
        }
        redisInstance.keyInfo.cursor = "0";
        // In case of refresh (Maybe after user start monitoring)
        redisInstance.keyInfo.previousCursors = ["0"];  
        // iter from current cursor with pagesize
        redisutils.scanRedisTree(redisInstance,
            redisInstance.keyInfo.cursor,
            redisInstance.keyInfo.pattern,
            redisInstance.keyInfo.pageSize * redisInstance.keyInfo.pageSize,
            async (keys, cursor) => {
                redisInstance.keys = keys;
                redisInstance.keyInfo.cursor = cursor;
                redisInstance.keyInfo.pageIndex++;
                redisInstance.keyInfo.hasMoreKeys = cursor !== "0";
                
                redisInstance.ioStreamer.next([{type: monitoractions.UPDATE_LOCAL_TREE}])  
        })
    });

    client.on(actions.DISCONNECT_REDIS_INSTANCE, async (redisId) => {
        const redisInstance = db.redisInstances.find(p=>p.roomId == redisId);
        if (!redisInstance) {
            client.emit(actions.CONNECT_REDIS_INSTANCE_FAIL,
                {error: 'This should not happen!'})
        }
        db.redisInstances = db.redisInstances.filter(p=> p.roomId != redisId);
        client.emit(actions.DISCONNECT_REDIS_INSTANCE_SUCCESS,
            {redisId:redisId})
        client.leave(redisId);
    });

    client.on('disconnect', async () => {
      console.log('Client disconnected')
      db.redisInstances = [];
    });

});
