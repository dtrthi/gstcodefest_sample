// Precondition: You need to require socket.io.js in your html page
// Reference link https://socket.io
// <script src="socket.io.js"></script>

const logger = console;

const TimeInOneCell = 500;
const AroundPivotLimit = 5;
const MinimumDistance = 5;
const MinimumEggAttackTime = 15;
const DangerBombTime = 530;
const checkFullPower = false;
const AvoidMystic = true;
const EnableEndGame = false;

const MapCell = {
    Road: 0,
    Wall: 1,
    Balk: 2,
    TeleportGate: 3,
    QuarantinePlace: 4,
    DragonEgg: 5,
};

const AllCellTypes = new Set([
    MapCell.Road,
    MapCell.Wall,
    MapCell.Balk,
    MapCell.TeleportGate,
    MapCell.QuarantinePlace,
    MapCell.DragonEgg,
]);

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
    constructor(val, dir = null, parent = null) {
        this.val = val;
        this.dir = dir;
        this.parent = parent;
        this.children = [];
        this.boxes = 0;
        this.isolatedBoxes = 0;
        this.avoidThis = false;
        this.attackThis = false;
        this.playerFootprint = false;
        if (parent) {
            this.distance = parent.distance + 1;
            this.bonusPoints = parent.bonusPoints;
        } else {
            this.distance = 0;
            this.bonusPoints = 0;
        }
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
    constructor(socket, playerId) {
        this.socket = socket;
        this.playerId = playerId;
        this.gameStart = false;
        this.tickId = 0;
        this.mapInfo = {};
        this.map = [];
        this.flatMap = [];
        this.mapWidth = 0;
        this.mapHeight = 0;
        this.playerMap = new Map();
        this.opponentPositions = new Set();
        this.mystics = new Set();
        this.eggs = new Set();
        this.oldOpponentBombs = [];
        this.newOpponentBombs = [];
        this.bombSpots = new Set();
        this.bombDangers = new Set();
        this.bombPositions = new Set();
        this.bombMap = new Map();
        this.rottenBoxes = new Set();
        this.gameLock = true;
        this.endGame = false;
        this.roadMap = [];
        this.destinationStart = Date.now();
        this.destinationEnd = Date.now();
        this.haltSignal = false;
        this.haltSignalTime = -1;

        this.reachableCells = new Set();
        this.emptyCells = new Set();
        this.pivotNode = null;
        this.editableEggs = new Set();

        this.allLeaves = new Map();
        this.gstTargets = [];
        this.spot1 = null;
        this.spot2 = null;
        this.gstEgg1 = null;
        this.gstEgg2 = null;
        this.ignoreMystic = true;

        // game state
        this.avoidMystic = AvoidMystic;
        this.canMove = false;
        this.indanger = false;
        this.canBomb = true;
        this.haveEditableEggs = false;

        this.gstEggBeingAttacked = 0;

        this.countGoExploreSpecialSpot = 0;
    }

    run() {
        const gameLoop = () => {
            if (this.gameLock === false) {
                this.gameLock = true;
                let startPosition = this.player.position;

                if (this.roadMap[0] === this.player.position) {
                    //logger.info(this.player.position);
                    this.roadMap.shift();
                    this.idleStart = Date.now();

                    if (this.roadMap.length === 0) {
                        //logger.info('reach destination...');
                        this.recheckCanBomb();
                    }
                }

                if (this.roadMap.length && Date.now() - this.idleStart > TimeInOneCell) {
                //if (
                //    !this.haltSignal &&
                //    !this.waitForNextStop &&
                //    this.roadMap.length &&
                //    Date.now() - this.idleStart > TimeInOneCell
                //) {
                    logger.info('idling... reset the destination');
                    this.roadMap = [];
                    this.recheckCanBomb();
                    //this.haltSignal = true;
                    //this.socket.emit('drive player', { direction: 'x' });
                    //this.haltSignalTime = Date.now();
                }

                if (this.waitForNextStop && Date.now() - this.haltSignalTime > TimeInOneCell) {
                    this.waitForNextStop = false;
                    this.roadMap = [];
                    this.recheckCanBomb();
                }
                if (!this.roadMap.length) {
                    //console.log('make a choice...');
                    if (this.indanger) {
                        //console.log('in danger');
                        this.gotoSafePlace();
                    } else if (
                        this.countGoExploreSpecialSpot < 2 &&
                        this.specialSpot && this.reachableCells.has(this.specialSpot)
                    ) {
                        //console.log('count...', this.countGoExploreSpecialSpot);
                        if (this.nearTheSpecialSpot()) {
                            //console.log('try bomb special spot');
                            this.tryBombSpecialSpot();
                        } else {
                            //console.log('go explore special spot');
                            this.goExploreSpecialSpot();
                        }
                    } else if (this.canBomb) {
                        //console.log('go bomb...');
                        this.goBomb();
                    } else {
                        //console.log('go to good spot...');
                        this.goToGoodSpot();
                    }
                }
                this.gameLock = false;
            }
        }

        gameLoop();
    }

    parseTicktack(id, res) {
        //console.log(id, res.map_info);
        const mapInfo = res.map_info;
        this.mapInfo = mapInfo;
        this.tickId = this.tickId + 1;
        this.map = mapInfo.map;
        this.flatMap = this.map.flat();

        this.checkForSpecialSpot(this.flatMap);

        this.mapWidth = mapInfo.size.cols;
        this.mapHeight = mapInfo.size.rows;
        const currentPlayer = mapInfo.players.find(p => this.playerId.includes(p.id));
        this.player = new GamePlayer(this, currentPlayer);
        const opponents = mapInfo.players.filter(p => !this.playerId.includes(p.id));
        this.opponentPositions = new Set();
        this.gstEggBeingAttacked = 0;
        for (let opponent of opponents) {
            const p = opponent.currentPosition;
            this.opponentPositions.add(this.to1dPos(p.col, p.row));
            this.gstEggBeingAttacked = opponent.gstEggBeingAttacked;
        }
        this.playerMap = new Map();
        for (let player of mapInfo.players) {
            this.playerMap.set(player.id, player);
        }
        this.playerGst = null;
        this.targetGst = null;
        for (let gstEgg of mapInfo.dragonEggGSTArray) {
            if (!this.playerId.includes(gstEgg.id)) {
                this.targetGst = this.to1dPos(gstEgg.col, gstEgg.row);
            }
            if (gstEgg.id === this.playerId) {
                this.playerGst = this.to1dPos(gstEgg.col, gstEgg.row);
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
        this.rottenBoxes = new Set();
        this.bombSpots = new Set();
        this.bombDangers = new Set();
        this.bombPositions = new Set();
        this.newOpponentBombs = [];
        this.bombMap = new Map();
        const bombs = mapInfo.bombs;
        bombs.sort((a, b) => b.remainTime - a.remainTime);
        for (let bomb of bombs) {
            const bombPos = this.to1dPos(bomb.col, bomb.row);
            const bombSpots = this.getBombSpots(bombPos, bomb.playerId);
            this.bombPositions.add(bombPos);
            this.bombSpots = new Set([...this.bombSpots, ...bombSpots]);
            if (bomb.remainTime < DangerBombTime) {
                this.bombDangers = new Set([...this.bombDangers, ...bombSpots]);
            }
            for (let spot of bombSpots) {
                this.bombMap.set(spot, bomb.remainTime);
            }
            if (!this.playerId.includes(bomb.playerId)) {
                this.newOpponentBombs.push(bombPos);
            }
        }
        const hasNewBomb = this.newOpponentBombs.filter(b => this.oldOpponentBombs.indexOf(b) === -1).length > 0;
        this.oldOpponentBombs = this.newOpponentBombs;
        if (hasNewBomb && this.roadMap.filter(c => this.bombSpots.has(c)).length) {
            this.haltSignal = true;
            this.socket.emit('drive player', { direction: 'x' });
            this.haltSignalTime = Date.now();
        }

        // update game state
        if (!this.gameStart) {
            this.canMove = true;
            this.gameLock = false;
        }
        const playerPosition = this.player.position;
        this.indanger = this.bombSpots.has(playerPosition);
        this.endGame = EnableEndGame && this.flatMap.filter(c => c === MapCell.Balk).length <= 5;
        this.updateMap(res.tag, res.player_id);

        this.gameStart = true;
        this.ignoreMystic = this.gstEggBeingAttacked < MinimumEggAttackTime;

        //
        this.readMap1();
        [this.spot1, this.gstEgg1] = this.readMap2();
        [this.spot2, this.gstEgg2] = this.readMap2(true);
        [this.spot3, this.gstEgg3] = this.readMap2(true, true);
        this.run();
    }

    onJoinGame(res) {
        if (this.playerId.includes(res.player_id)) {
            this.playerId = res.player_id;
        }
    }

    onPlayerStop(res) {
        if (res.player_id === this.playerId) {
            if (res.direction === 'x') {
                this.haltSignal = false;
                this.waitForNextStop = true;
                //this.roadMap = [];
                //this.recheckCanBomb();
            }
        }
    }

    recheckCanBomb() {
        const canBomb = this.mapInfo.bombs.filter(b => this.playerId.includes(b.playerId)).length === 0;
        if (canBomb) {
            this.canBomb = canBomb;
        }
    }

    updateMap(tag, player_id) {
        if (this.playerId.includes(player_id)) {
            //console.log(tag, player_id, this.to2dPos(this.player.position));
            if (tag === 'player:stop-moving') {
                if (this.waitForNextStop) {
                    this.waitForNextStop = false;
                    this.roadMap = [];
                    this.recheckCanBomb();
                }
            }
            if (tag === 'player:moving-banned') {
                if (this.canMoveHandler) {
                    clearTimeout(this.canMoveHandler);
                    this.canMoveHandler = null;
                }
                this.canMove = true;
                this.roadMap = [];
                this.recheckCanBomb();
            } else if (tag === 'bomb:setup') {
                this.canBomb = false;
                //const delay = 2000; //this.player?.playerInfo?.delay ?? 2000;
                const delay = this.player?.playerInfo?.delay ?? 2000;
                setTimeout(() => this.canBomb = true, delay);
            }
        } else if (!this.playerId.includes(player_id)) {
            //console.log(tag, player_id);
            if (tag === 'bomb:setup' && !this.haltSignal) {
                //this.haltSignal = true;
                //this.socket.emit('drive player', { direction: 'x' });
            }
        }
    }

    onJoinGame(res) {
        if (this.playerId.includes(res.player_id)) {
            this.playerId = res.player_id;
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
        let node = this.getAvoidBomb(root, this.flatMap, this.bombSpots);
        if (!node) {
            node = this.getAvoidBomb(root, this.flatMap, this.bombSpots, true);
        }
        if (!node) {
            node = this.getAvoidBomb(root, this.flatMap, this.bombSpots, true, true);
        }

        if (node) {
            //console.log('extend path', extendPath);
            const path = getPathFromRoot(node);
            this.drivePlayer(path, node);
            this.storeRoadMap([node]);
        }
    }

    goBomb() {
        let standNode = null;
        let withMystic = false;
        let withTeleport = false;
        if (this.spot1) {
            standNode = this.spot1;
            withMystic = false;
        } else if (this.spot2) {
            standNode = this.spot2;
            withMystic = true;
        } else if (Date.now() - this.idleStart > TimeInOneCell * 22 && this.spot3) {
            standNode = this.spot3;
            withMystic = true;
            withTeleport = true;
        } else if (this.gstEgg1) {
            standNode = this.gstEgg1;
            withMystic = false;
        } else if (this.gstEgg2) {
            standNode = this.gstEgg2;
            withMystic = true;
        } else if (Date.now() - this.idleStart > TimeInOneCell * 22 && this.gstEgg3) {
            standNode = this.gstEgg3;
            withMystic = true;
            withTeleport = true;
        }
        if (standNode) {
            //console.log('target', this.to2dPos(standNode.val));
            const node = new TreeNode(standNode.val);
            const extendPath = this.findSafePlace(standNode.val, new Set([
                ...this.getBombSpots(standNode.val, this.playerId),
                ...this.bombSpots,
            ]), standNode.distance, withMystic, withTeleport);
            if (extendPath) {
                const direction = getPathFromRoot(standNode);
                const tailPath = getPathFromRoot(extendPath);
                this.drivePlayer(direction + 'b' + tailPath, standNode);
                this.storeRoadMap([extendPath, standNode]);
                //this.canBomb = false;
            }
        }
    }

    goEatSomeEggs() {
        //console.log('Go eat some eggs');
        const root = new TreeNode(this.player.position, null, null);
        let node = this.getEdiableEggsPath(root, this.flatMap);
        let path = '';
        if (node) {
            //console.log('extend path', extendPath);
            path = getPathFromRoot(node);
            const pathLen = path.length;
            if (!this.endGame && pathLen > 3) {
                return;
            }
            //for (let [pos, leaf] of allLeaves) {
            if (path) {
                this.drivePlayer(path, node);
                this.storeRoadMap([node]);
            }
        }
    }

    getBombSpots(pos, playerId) {
        let playerPower = 3;
        const player = this.playerMap.get(playerId);
        if (player) {
            playerPower = player.power;
        }
        const passThroughCells = new Set([MapCell.Road, MapCell.TeleportGate]);
        const bombSpots = new Set([pos]);
        const allDirections = [-1, 1, -this.mapWidth, this.mapWidth];
        for (let d of allDirections) {
            for (let i = 1; i <= playerPower; i++) {
                const p = pos + d * i;
                const cellType = this.flatMap[p];
                if (!passThroughCells.has(cellType)) {
                    if (cellType === MapCell.Balk) {
                        this.rottenBoxes.add(p);
                    }
                    break;
                }
                bombSpots.add(p);
            }
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
        const playerPower = this.playerMap.get(this.playerId)?.power ?? 1;
        let boxes = 0;
        let isolatedBoxes = 0;
        const allDirections = [-1, 1, -this.mapWidth, this.mapWidth];
        for (let d of allDirections) {
            for (let i = 1; i <= playerPower; i++) {
                const p = loc + d * i;
                let cellType = this.flatMap[p];
                if (cellType === MapCell.Wall) {
                    break;
                }
                if (cellType === MapCell.DragonEgg) {
                    if (p === this.playerGst) {
                        node.avoidThis = true;
                    }
                    if (p === this.targetGst) {
                        node.attackThis = true;
                    }
                    break;
                }
                if (cellType === MapCell.Balk && !this.rottenBoxes.has(p)) {
                    if (this.isIsolatedBalk(p)) {
                        isolatedBoxes += 1;
                    } else {
                        boxes += 1;
                    }
                    break;
                }

                if (this.opponentPositions.has(p)) {
                    node.playerFootprint = true;
                }
            }
        }
        node.boxes = boxes;
        node.isolatedBoxes = isolatedBoxes;
    }

    getAllLeaves(startNode, map) {
        this.allLeaves = new Map();
        this.gstTargets = [];

        this.scanMap(startNode, map, (currentNode) => {
            if (this.bombSpots.has(currentNode.val)) {
                return [null, true];
            }
            if (this.eggs.has(currentNode.val)) {
                currentNode.bonusPoints += 1;
            }
            this.countBoxHits(currentNode);
            if (currentNode.boxes > 0 && !currentNode.avoidThis) {
                this.allLeaves.set(currentNode.val, currentNode);
            }
            if (currentNode.attackThis) {
                this.gstTargets.push(currentNode);
            }

            return [null, false];
        });
    }

    getAvoidBomb(startNode, map, bombSpots, withMystic = false, withTeleport = false) {
        const goodSpots = new Set();
        let limit = 20;
        this.scanRawMap(startNode, map, (currentNode) => {
            const loc = currentNode.val;
            if (this.opponentPositions.has(loc)) {
                return [null, true];
            }
            if (!withMystic && this.mystics.has(loc)) {
                return [null, true];
            }
            if (startNode.val !== loc && this.bombPositions.has(loc)) {
                return [null, true];
            }
            if (startNode.val !== loc && this.bombDangers.has(loc)) {
                return [null, true];
            }
            if (!bombSpots.has(loc) || (withTeleport && map[loc] === MapCell.TeleportGate)) {
                if (this.eggs.has(loc)) {
                    currentNode.bonusPoints += 1;
                }
                this.countBoxHits(currentNode);
                const isGoodSpot1 = currentNode.boxes > 0 && !currentNode.avoidThis;
                const isGoodSpot2 = currentNode.attackThis;

                if (goodSpots.size === 0 || isGoodSpot1 || isGoodSpot2) {
                    goodSpots.add(currentNode);
                }

                if (--limit <= 0) {
                    return [true, false];
                }
            }
            return [null, false];
        }, withTeleport);

        let limitDistance = Infinity;
        if (this.pivotNode) {
            limitDistance = this.pivotNode.distance + AroundPivotLimit;
        }
        let goodSpot = null;
        let foundOpponentEgg = false;
        for (let spot of goodSpots) {
            if (!foundOpponentEgg && spot.attackThis) {
                foundOpponentEgg = true;
                goodSpot = spot;
                continue;
            }
            if (!goodSpot) {
                goodSpot = spot;
                continue;
            }

            if (spot.distance > limitDistance) {
                break;
            }

            const points = spot.boxes + spot.bonusPoints;
            if ((goodSpot.boxes + goodSpot.bonusPoints) < points) {
                goodSpot = spot;
            }
        }
        return goodSpot;
    }

    getEdiableEggsPath(startNode, map) {
        return this.scanMap(startNode, map, (currentNode) => {
            if (this.bombSpots.has(currentNode.val)) {
                return [null, true];
            }
            if (this.eggs.has(currentNode.val)) {
                return [currentNode, false];
            }
            return [null, false];
        });

        return null;
    }

    scanMap(startNode, map, callback) {
        return this.scanRawMap(startNode, map, (currentNode) => {
            const loc = currentNode.val;
            if (this.opponentPositions.has(loc)) {
                return [null, true];
            }
            if (this.mystics.has(loc)) {
                return [null, true];
            }
            if (this.bombDangers.has(loc)) {
                return [null, true];
            }

            if (callback) {
                return callback(currentNode);
            }
            return [null, false];
        });
    }

    scanRawMap(startNode, map, callback, withTeleport = false) {
        const queue = [startNode];
        const visited = new Set([startNode.val]);
        while (queue.length) {
            const currentNode = queue.shift();

            if (callback) {
                const [r, ignoreThisNode] = callback(currentNode);
                if (ignoreThisNode) {
                    continue;
                }
                if (r) {
                    return r;
                }
            }

            const neighbors = this.getNeighborNodes(currentNode.val);

            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === MapCell.Road || (withTeleport && cellValue === MapCell.TeleportGate)) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode, currentNode.bonusPoints);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                    }
                }
            }
        }

        return null;
    }

    readMap1() {
        this.pivotNode = null;
        const attackThisNodes = [];
        const map = this.flatMap;
        const position = this.player.position;
        const startNode = new TreeNode(position);
        const queue = [startNode];
        const visited = new Set([position]);
        //console.log('start read map 1', this.to2dPos(position));
        while (queue.length) {
            const currentNode = queue.shift();
            this.reachableCells.add(currentNode.val);
            this.countBoxHits(currentNode);
            if (currentNode.boxes === 0 && !currentNode.attackThis) {
                this.emptyCells.add(currentNode.val);
            }
            //console.log('read map 1', this.to2dPos(currentNode.val), currentNode.boxes);
            if (currentNode.boxes && !this.pivotNode) {
                //console.log('found pivot node');
                this.pivotNode = currentNode;
                //console.log('found pivot node - pivot node', this.to2dPos(this.pivotNode.val), this.pivotNode.distance);
            }
            if (currentNode.attackThis) {
                attackThisNodes.push(currentNode);
            }

            const neighbors = this.getNeighborNodes(currentNode.val);
            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                //console.log(this.to2dPos(neighbor), cellValue);
                if (cellValue === MapCell.Road || this.rottenBoxes.has(neighbor)) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                    }
                }
            }
        }

        if (!this.pivotNode && attackThisNodes.length) {
            this.pivotNode = attackThisNodes[0];
        }

        return null;
    }

    readMap2(withMystic = false, withTeleport = false) {
        const attackSpots = [];
        const gstTargets = [];

        const map = this.flatMap;
        const position = this.player.position;
        const startNode = new TreeNode(position);
        const queue = [startNode];
        const visited = new Set([position]);
        while (queue.length) {
            const currentNode = queue.shift();
            const p = currentNode.val;

            if (this.opponentPositions.has(p)) {
                continue;
            }
            if (this.bombPositions.has(p)) {
                continue;
            }
            if (this.ignoreMystic && !withMystic && this.mystics.has(p)) {
                continue;
            }

            if (this.bombMap.has(p)) {
                const bombTime = this.bombMap.get(p);
                if (!this.canWalkThrough(bombTime, currentNode.distance)) {
                    continue;
                }
            }
            this.countBoxHits(currentNode);
            if (this.eggs.has(currentNode.val)) {
                currentNode.bonusPoints += 1;
            }
            if (
                (
                    currentNode.boxes > 0 ||
                    currentNode.isolatedBoxes > 1
                ) && !currentNode.avoidThis
            ) {
                attackSpots.push(currentNode);
            }
            if (currentNode.attackThis) {
                gstTargets.push(currentNode);
            }

            const neighbors = this.getNeighborNodes(currentNode.val);
            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === MapCell.Road || (withTeleport && cellValue === MapCell.TeleportGate)) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                    }
                }
            }
        }

        let goodSpot = null;
        let limitDistance = Infinity;
        if (this.pivotNode) {
            limitDistance = this.pivotNode.distance + AroundPivotLimit;
        }
        for (let spot of attackSpots) {
            if (spot.distance > limitDistance) {
                break;
            }

            if (!goodSpot) {
                goodSpot = spot;
                continue;
            }

            if (spot.distance < 6 && spot.playerFootprint) {
                goodSpot = spot;
                console.log('found opponent', this.to2dPos(goodSpot.val));
                break;
            }
            /*
            let points = spot.boxes;
            let goodSpotPoints = goodSpot.boxes;
            if (!this.isFullPower()) {
                points = spot.boxes * 0.7 + spot.bonusPoints * 0.2;
                goodSpotPoints = goodSpot.boxes * 0.7 + goodSpot.bonusPoints * 0.2;
            }
            */
            if (this.checkForGoodSpot(spot, goodSpot)) {
                goodSpot = spot;
            }
        }
        let attackGSTEggSpot = null;
        for (let node of gstTargets) {
            if (node.distance > limitDistance) {
                break;
            }
            attackGSTEggSpot = node;
            break;
        }

        return [goodSpot, attackGSTEggSpot];
    }

    canWalkThrough(bombTime, distance) {
        //return distance * 330 + 650 < bombTime;
        return distance * 430 + 450 < bombTime;
    }

    drivePlayer(path, node) {
        const pathLen = path.split('').filter(c => c !== 'b').length;
        if (path) {
            this.socket.emit('drive player', { direction: path });
        }
        //this.canMove = false;
        //this.canMoveHandler = setTimeout(() => this.canMove = true, 250 * pathLen);
    }

    storeRoadMap(nodes) {
        this.roadMap = [];
        this.destinationStart = Date.now();
        for (let node of nodes) {
            let n = node;
            while (n) {
                this.roadMap.unshift(n.val);
                n = n.parent;
            }
        }
    }

    goToGoodSpot() {
        const goodSpot1 = this.findGoodSpot(this.player.position);
        const goodSpot2 = this.findGoodSpot(this.player.position, true);
        const goodSpot = goodSpot1 ?? goodSpot2;
        if (goodSpot) {
            const path = getPathFromRoot(goodSpot);
            if (path) {
                this.drivePlayer(path, goodSpot);
                this.storeRoadMap([goodSpot]);
            }
        }
    }

    findGoodSpot(position, withMystic = false, withTeleport = false) {
        const goodSpots = [];
        const badSpots = [];

        let limitDistance = Infinity;
        if (this.pivotNode) {
            limitDistance = this.pivotNode.distance + AroundPivotLimit;
        }

        const map = this.flatMap;
        const startNode = new TreeNode(position);
        const queue = [startNode];
        const visited = new Set([position]);
        while (queue.length) {
            const currentNode = queue.shift();
            const p = currentNode.val;

            if (currentNode.distance > limitDistance) {
                break;
            }

            //console.log(this.to2dPos(p));
            if (this.opponentPositions.has(p)) {
                continue;
            }
            if (p !== position && this.bombPositions.has(p)) {
                continue;
            }
            if (!withMystic && this.mystics.has(p)) {
                continue;
            }

            if (this.bombMap.has(p)) {
                const bombTime = this.bombMap.get(p);
                if (!this.canWalkThrough(bombTime, currentNode.distance)) {
                    continue;
                }
            }
            this.countBoxHits(currentNode);
            if (this.eggs.has(currentNode.val)) {
                currentNode.bonusPoints += 1;
            }
            if (
                !goodSpots.length ||
                currentNode.bonusPoints ||
                currentNode.boxes ||
                currentNode.isolatedBoxes > 1 ||
                currentNode.attackThis ||
                currentNode.playerFootprint
            ) {
                if (!this.bombSpots.has(p)) {
                    goodSpots.push(currentNode);
                } else {
                    badSpots.push(currentNode);
                }
            }

            const neighbors = this.getNeighborNodes(currentNode.val);
            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === MapCell.Road || (withTeleport && cellValue === MapCell.TeleportGate)) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor); const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                    }
                }
            }
        }

        let goodSpot = null;
        for (let spot of goodSpots) {
            if (!goodSpot) {
                goodSpot = spot;
                continue;
            }
            if (this.checkForGoodSpot(spot, goodSpot)) {
                goodSpot = spot;
            }
        }
        if (!goodSpot) {
            for (let spot of badSpots) {
                console.log('bad spot', spot);
                goodSpot = spot;
            }
        }

        return goodSpot;
    }

    findSafePlace(position, dangerSpots, initDistance = 0, withMystic = false, withTeleport = false) {
        const goodSpots = [];

        const map = this.flatMap;
        const startNode = new TreeNode(position);
        startNode.distance = initDistance;
        const queue = [startNode];
        const visited = new Set([position]);
        while (queue.length) {
            const currentNode = queue.shift();
            const p = currentNode.val;

            //console.log(this.to2dPos(p));
            if (this.opponentPositions.has(p)) {
                continue;
            }
            if (p !== position && this.bombPositions.has(p)) {
                continue;
            }
            if (this.ignoreMystic && !withMystic && this.mystics.has(p)) {
                continue;
            }

            if (this.bombMap.has(p)) {
                const bombTime = this.bombMap.get(p);
                if (!this.canWalkThrough(bombTime, currentNode.distance)) {
                    continue;
                }
            }
            this.countBoxHits(currentNode);
            if (this.eggs.has(currentNode.val)) {
                currentNode.bonusPoints += 1;
            }
            if (
                !goodSpots.length ||
                currentNode.bonusPoints ||
                currentNode.boxes ||
                currentNode.isolatedBoxes > 1 ||
                currentNode.attackThis
            ) {
                if (!dangerSpots.has(p)) {
                    goodSpots.push(currentNode);
                }
            }

            const neighbors = this.getNeighborNodes(currentNode.val);
            for (let idx in neighbors) {
                const neighbor = neighbors[idx];
                const cellValue = map[neighbor];
                if (cellValue === MapCell.Road || (withTeleport && cellValue === MapCell.TeleportGate)) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor); const dir = parseInt(idx, 10) + 1;
                        const neighborNode = new TreeNode(neighbor, dir.toString(), currentNode);
                        currentNode.children.push(neighborNode);
                        queue.push(neighborNode);
                    }
                }
            }
        }

        let goodSpot = null;
        let firstDistance = Infinity;
        let foundOpponentEgg = false;
        for (let spot of goodSpots) {
            if (!goodSpot) {
                goodSpot = spot;
                firstDistance = spot.distance;
                if (goodSpot.attackThis) {
                    foundOpponentEgg = true;
                }
                continue;
            }
            if (!foundOpponentEgg && spot.attackThis && spot.distance < firstDistance + MinimumDistance) {
                foundOpponentEgg = true;
                goodSpot = spot;
                continue;
            }
            const points = spot.bonusPoints;
            const goodSpotPoints = goodSpot.bonusPoints;
            if (
                (
                    goodSpot.boxes < spot.boxes ||
                    (goodSpotPoints < 1 && goodSpotPoints < points)
                ) &&
                spot.distance < firstDistance + MinimumDistance
            ) {
                goodSpot = spot;
            }
        }

        return goodSpot;
    }

    checkForSpecialSpot(map) {
        for (let c in map) {
            const cellType = map[c];
            if (!AllCellTypes.has(cellType)) {
            //if (this.targetGst == c) {
                this.specialSpot = parseInt(c, 10);
                break;
            }
        }
    }

    nearTheSpecialSpot() {
        if (this.specialSpot) {
            const neighbors = this.getNeighborNodes(this.specialSpot);
            return neighbors.includes(this.player.position);
        }
        return false;
    }

    tryBombSpecialSpot() {
        //console.log('try bomb special spot');
        this.socket.emit('drive player', {direction: 'b'});
        this.countGoExploreSpecialSpot += 1;
    }

    goExploreSpecialSpot() {
        //console.log('go explore special spot');
        this.countGoExploreSpecialSpot += 1;
        const target = this.specialSpot;
        const startNode = new TreeNode(target);
        const map = this.flatMap;
        const node = this.scanRawMap(startNode, map, (currentNode) => {
            const loc = currentNode.val;
            if (this.opponentPositions.has(loc)) {
                return [null, true];
            }
            if (this.bombDangers.has(loc)) {
                return [null, true];
            }

            if (currentNode.val === target) {
                return [currentNode, false];
            }

            return [null, false];
        });

        if (node) {
            const path = getPathFromRoot(node);
            this.drivePlayer(path, node);
            this.storeRoadMap([node]);
        }
    }

    isFullPower() {
        return checkFullPower && this.player.playerInfo.dragonEggSpeed >= 2 &&
            this.player.playerInfo.dragonEggAttack >= 3 &&
            this.player.playerInfo.dragonEggDelay >= 3;
    }

    isIsolatedBalk(pos) {
        const cols = this.mapWidth;
        const surroundSpots = [
            pos - 1,
            pos + 1,
            pos - cols,
            pos - cols - 1,
            pos - cols + 1,
            pos + cols,
            pos + cols - 1,
            pos + cols + 1,
        ];

        for (let spot of surroundSpots) {
            if (
                this.flatMap[spot] === MapCell.Balk ||
                this.flatMap[spot] === MapCell.TeleportGate ||
                spot === this.targetGst
            ) {
                return false;
            }
        }
        return true;
    }

    checkForGoodSpot(spot, goodSpot) {
        let points = spot.boxes * spot.isolatedBoxes * 0.5;
        let goodSpotPoints = goodSpot.boxes * goodSpot.isolatedBoxes * 0.5;
        if (!this.isFullPower()) {
            points = spot.boxes * 0.7 + spot.bonusPoints * 0.2 * spot.isolatedBoxes * 0.5;
            goodSpotPoints = goodSpot.boxes * 0.7 + goodSpot.bonusPoints * 0.2 * goodSpot.isolatedBoxes * 0.5;
        }
        return goodSpotPoints < points;
    }
}

exports.GameMap = GameMap;
