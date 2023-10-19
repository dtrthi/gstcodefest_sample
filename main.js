// Precondition: You need to require socket.io.js in your html page
// Reference link https://socket.io
// <script src="socket.io.js"></script>

const apiServer = 'http://localhost:8888/';
const gameId = '2f7c1a22-1ddc-444c-992a-ffc7b4c9876d';
const playerId = 'player1-xxx';

const SpoilType = {
    Mystic: 6
};

function getPathFromRoot(node) {
    if (!node.parent) {
        return '';
    }

    return getPathFromRoot(node.parent) + node.dir;
}

class TreeNode {
    constructor(val, dir, parent) {
        this.val = val;
        this.dir = dir;
        this.parent = parent;
        this.children = [];
        this.boxes = 0;
    }
}

class GamePlayer {
    constructor(gameMap, playerInfo) {
        this.position = 0;
        this.playerInfo = playerInfo;
        if (playerInfo) {
            const p = playerInfo?.currentPosition;
            this.position = gameMap.to1dPos(p.col, p.row);
        }
    }
}

class GameMap {
    constructor(playerId) {
        this.playerId = playerId;
        this.gameStart = false;
        this.tickId = 0;
        this.map = [];
        this.flatMap = [];
        this.mapWidth = 0;
        this.mapHeight = 0;
        this.playerMap = new Map();
        this.opponentPositions = new Set();
        this.mystics = new Set();
        this.eggs = new Set();
        this.bombSpots = new Set();
        this.bombDangers = new Set();
        this.gameLock = true;
        this.endGame = false;

        // game state
        this.avoidMystic = true;
        this.canMove = false;
        this.indanger = false;
        this.canBomb = true;
        this.haveEditableEggs = false;
    }

    run() {
        const gameLoop = () => {
            if (this.gameLock === false) {
                this.gameLock = true;
                let startPosition = this.player.position;
                if (this.canMove) {
                    if (this.indanger) {
                        this.gotoSafePlace();
                    } else if (this.canBomb) {
                        this.goBomb();
                    } else if (this.haveEditableEggs) {
                        this.goEatSomeEggs();
                    }
                }
                this.gameLock = false;
            }
        }

        setInterval(gameLoop, 100);
    }

    parseTicktack(id, mapInfo, res) {
        //console.log(id, res);
        this.tickId = this.tickId + 1;
        this.map = mapInfo.map;
        this.flatMap = this.map.flat();
        this.mapWidth = mapInfo.size.cols;
        this.mapHeight = mapInfo.size.rows;
        const currentPlayer = mapInfo.players.find(p => p.id === playerId);
        this.player = new GamePlayer(this, currentPlayer);
        const opponents = mapInfo.players.filter(p => p.id !== playerId);
        this.opponentPositions = new Set();
        for (let opponent of opponents) {
            const p = opponent.currentPosition;
            this.opponentPositions.add(this.to1dPos(p.col, p.row));
        }
        this.playerMap = new Map();
        for (let player of mapInfo.players) {
            this.playerMap.set(player.id, player);
        }
        this.targetGst = null;
        for (let gstEgg of mapInfo.dragonEggGSTArray) {
            if (gstEgg.id !== this.playerId) {
                this.targetGst = this.to1dPos(gstEgg.col, gstEgg.row);
            }
        }
        this.mystics = new Set();
        this.eggs = new Set();
        for (let spoil of mapInfo.spoils) {
            if (this.avoidMystic && spoil.spoil_type === SpoilType.Mystic) {
                this.mystics.add(this.to1dPos(spoil.col, spoil.row));
            } else {
                this.eggs.add(this.to1dPos(spoil.col, spoil.row));
            }
        }
        this.bombSpots = new Set();
        for (let bomb of mapInfo.bombs) {
            const bombPos = this.to1dPos(bomb.col, bomb.row);
            this.bombSpots = new Set([
                ...this.bombSpots,
                ...this.getBombSpots(bombPos, bomb.playerId),
        ]);
        }

        // update game state
        if (!this.gameStart) {
            this.canMove = true;
            this.gameLock = false;
        }
        const playerPosition = this.player.position;
        this.indanger = this.bombSpots.has(playerPosition);
        this.canBomb = mapInfo.bombs.filter(b => b.playerId === this.playerId).length === 0;
        this.haveEditableEggs = this.eggs.size > 0;
        this.updateMap(res.tag, res.player_id);

        this.gameStart = true;
    }

    updateMap(tag, player_id) {
        if (player_id === this.playerId) {
            console.log(tag);
            if (tag === 'player:stop-moving') {
                //if (this.canMoveHandler) {
                //    clearTimeout(this.canMoveHandler);
                //    this.canMoveHandler = null;
                //}
                //this.canMove = true;
            }
        }
    }

    to2dPos(pos) {
        const cols = this.mapWidth;
        const y = Math.floor(pos / cols);
        const x = pos % cols;
        return [x, y];
    }

    to1dPos(x, y) {
        const cols = this.mapWidth;
        return y * cols + x;
    }

    gotoSafePlace() {
        console.log('Go to safe place');
        const root = new TreeNode(this.player.position, null, null);
        let path = this.getAvoidBomb(root, this.flatMap, this.bombSpots);
        if (path) {
            //console.log('extend path', extendPath);
            path = getPathFromRoot(path);
        } else {
            path = '';
        }
        //for (let [pos, leaf] of allLeaves) {
        socket.emit('drive player', { direction: path });
        const pathLen = path.length;
        this.canMove = false;
        this.canMoveHandler = setTimeout(() => this.canMove = true, 400 * pathLen);
    }

    goBomb() {
        const root = new TreeNode(this.player.position, null, null);
        const allLeaves = this.getAllLeaves(root, this.flatMap);
        let pos, leaf;
        let rickLeaf = null;
        let limit = 10;
        for ([pos, leaf] of allLeaves) {
            if (!rickLeaf || rickLeaf.boxes < leaf.boxes) {
                rickLeaf = leaf;
            }
            if (--limit <= 0) {
                break;
            }
        }
        let extendPath;
        if (rickLeaf) {
            const node = new TreeNode(rickLeaf.val, null, null);
            extendPath = this.getAvoidBomb(node, this.flatMap, new Set([
                ...this.getBombSpots(rickLeaf.val, this.playerId),
                ...this.bombSpots,
            ]));
        }
        if (extendPath) {
            //console.log('extend path', extendPath);
            extendPath = getPathFromRoot(extendPath);
        } else {
            extendPath = '';
        }
        //for (let [pos, leaf] of allLeaves) {
        if (rickLeaf) {
            const direction = getPathFromRoot(rickLeaf);
            console.log('direction', direction, extendPath);
            const lastPathLen = (direction + extendPath).length;
            socket.emit('drive player', { direction: direction + 'b' + extendPath });
            this.canMove = false;
            this.canMoveHandler = setTimeout(() => this.canMove = true, 400 * lastPathLen);
        }
    }

    goEatSomeEggs() {
        console.log('Go eat some eggs');
        const root = new TreeNode(this.player.position, null, null);
        let path = this.getEdiableEggsPath(root, this.flatMap);
        if (path) {
            //console.log('extend path', extendPath);
            path = getPathFromRoot(path);
        } else {
            path = '';
        }
        const pathLen = path.length;
        if (!this.endGame && pathLen > 5) {
            return;
        }
        //for (let [pos, leaf] of allLeaves) {
        socket.emit('drive player', { direction: path });
        this.canMove = false;
        this.canMoveHandler = setTimeout(() => this.canMove = true, 400 * pathLen);
    }

    getBombSpots(pos, playerId) {
        let playerPower = 3;
        const player = this.playerMap.get(playerId);
        if (player) {
            playerPower = player.power;
        }
        const passThroughCells = new Set([0, 3]);
        const bombSpots = new Set([pos]);
        for (let i = 1; i <= playerPower; i++) {
            const p = pos - i;
            const cellType = this.flatMap[p];
            if (!passThroughCells.has(cellType)) {
                break;
            }
            bombSpots.add(p);
        }
        for (let i = 1; i <= playerPower; i++) {
            const p = pos + i;
            const cellType = this.flatMap[p];
            if (!passThroughCells.has(cellType)) {
                break;
            }
            bombSpots.add(p);
        }
        for (let i = 1; i <= playerPower; i++) {
            const p = pos - this.mapWidth * i;
            const cellType = this.flatMap[p];
            if (!passThroughCells.has(cellType)) {
                break;
            }
            bombSpots.add(p);
        }
        for (let i = 1; i <= playerPower; i++) {
            const p = pos + this.mapWidth * i;
            const cellType = this.flatMap[p];
            if (!passThroughCells.has(cellType)) {
                break;
            }
            bombSpots.add(p);
        }

        return bombSpots;
    }

     getNeighborNodes(val) {
        const cols = this.mapWidth;
        return [
            val - 1,
            val + 1,
            val - cols,
            val + cols,
        ];
    }

    countBoxHits(node) {
        const loc = node.val;
        const playerPower = this.playerMap.get(this.playerId).power;
        let box1 = 0, box2 = 0, box3 = 0, box4 = 0;
        let boxes = 0;
        for (let i = 1; i <= playerPower; i++) {
            let cellType = this.flatMap[loc - i];
            if (cellType === 1 || cellType === 5) {
                break;
            }
            if (cellType === 2) {
                box1 = 1;
                boxes += 1;
                break;
            }
        }
        for (let i = 1; i <= playerPower; i++) {
            let cellType = this.flatMap[loc + i];
            if (cellType === 1 || cellType === 5) {
                break;
            }
            if (cellType === 2) {
                box2 = 1;
                boxes += 1;
                break;
            }
        }
        for (let i = 1; i <= playerPower; i++) {
            let cellType = this.flatMap[loc - i * this.mapWidth];
            if (cellType === 1 || cellType === 5) {
                break;
            }
            if (cellType === 2) {
                box3 = 1;
                boxes += 1;
                break;
            }
        }
        for (let i = 1; i <= playerPower; i++) {
            let cellType = this.flatMap[loc + i * this.mapWidth];
            if (cellType === 1 || cellType === 5) {
                break;
            }
            if (cellType === 2) {
                box4 = 1;
                boxes += 1;
                break;
            }
        }

        node.boxes = boxes;
    }

    getAllLeaves(startNode, map) {
        const allLeaves = new Map();

        const queue = [startNode];
        const visited = new Set([startNode.val]);
        while (queue.length) {
            const currentNode = queue.shift();

            this.countBoxHits(currentNode);
            if (currentNode.boxes > 0) {
                allLeaves.set(currentNode.val, currentNode);
            }
            const neighbors = this.getNeighborNodes(currentNode.val);

            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === 0) {
                    //console.log('get cell can move', neighbor);
                    if (this.opponentPositions.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (this.mystics.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (!visited.has(neighbor)) {
                        const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                        visited.add(neighbor);
                    }
                }
            }
        }

        return allLeaves;
    }

    getAvoidBomb(startNode, map, bombHoles) {
        const queue = [startNode];
        const visited = new Set([startNode.val]);
        while (queue.length) {
            const currentNode = queue.shift();

            const neighbors = this.getNeighborNodes(currentNode.val);

            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === 0) {
                    //console.log('get cell can move', neighbor);
                    if (this.opponentPositions.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (this.mystics.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                        if (!bombHoles.has(neighbor)) {
                            return neighborNode;
                        }
                    }
                }
            }
        }

        return null;
    }

    getEdiableEggsPath(startNode, map) {
        const queue = [startNode];
        const visited = new Set([startNode.val]);
        while (queue.length) {
            const currentNode = queue.shift();

            const neighbors = this.getNeighborNodes(currentNode.val);

            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === 0) {
                    //console.log('get cell can move', neighbor);
                    if (this.opponentPositions.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (this.mystics.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (this.bombSpots.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                        if (this.eggs.has(neighbor)) {
                            return neighborNode;
                        }
                    }
                }
            }
        }

        return null;
    }
}

const gameMap = new GameMap(playerId);
gameMap.run();
const global = {
    ticktack: false,
    ticktackTimeoutId: null,
    isTicktack: true,
    mapInfo: null,
    map: [],
    mapSize: [0, 0],
    lastPos: 0,
    currentPlayerPosition: 0,
    isIdle: false,
    lastRun: false,
    opponentPositions: [],
    walkTime: 400,
    lastPathLen: 0,
    avoidNodes: new Set(),
    eggs: new Set(),
    bombPaths: new Set(),
};

// Connecto to API App server
console.log('Server URL: %s', apiServer);
console.log('gameId: %s', gameId);
console.log('playerId: %s', playerId);
const socket = io.connect(apiServer, { reconnect: true, transports: ['websocket'] });


// LISTEN SOCKET.IO EVENTS

// It it required to emit `join channel` event every time connection is happened
socket.on('connect', () => {
    document.getElementById('connected-status').innerHTML = 'ON';
    document.getElementById('socket-status').innerHTML = 'Connected';
    console.log('[Socket] connected to server');    
    // API-1a
    socket.emit('join game', { game_id: gameId, player_id: playerId });
});

socket.on('disconnect', () => {
    console.warn('[Socket] disconnected');
    document.getElementById('socket-status').innerHTML = 'Disconnected';
});

socket.on('connect_failed', () => {
    console.warn('[Socket] connect_failed');
    document.getElementById('socket-status').innerHTML = 'Connected Failed';
});


socket.on('error', (err) => {
    console.error('[Socket] error ', err);
    document.getElementById('socket-status').innerHTML = 'Error!';
});


// SOCKET EVENTS

// API-1b
socket.on('join game', (res) => {
    console.log('[Socket] join-game responsed', res);
    document.getElementById('joingame-status').innerHTML = 'ON';
});

//API-2
socket.on('ticktack player', (res) => {
    //console.info('> ticktack');
    //console.log('[Socket] ticktack-player responsed, map_info: ', res.map_info);
    document.getElementById('ticktack-status').innerHTML = 'ON';

    gameMap.parseTicktack(res.id, res.map_info, res);
});

// API-3a
// socket.emit('drive player', { direction: '111b333222' });

//API-3b
socket.on('drive player', (res) => {
    console.log('[Socket] drive-player responsed, res: ', res);
});

const input = document.querySelector('#input');
const sendBtn = document.querySelector('#send');

sendBtn.addEventListener('click', () => {
    const direction = input.value;
    socket.emit('drive player', { direction: direction });
});
