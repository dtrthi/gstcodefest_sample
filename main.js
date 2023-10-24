// Precondition: You need to require socket.io.js in your html page
// Reference link https://socket.io
// <script src="socket.io.js"></script>

const MapCell = {
    Road: 0,
    Wall: 1,
    Balk: 2,
    TeleportGate: 3,
    QuarantinePlace: 4,
    DragonEgg: 5,
};

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
    constructor(val, dir, parent, bonusPoints = 0) {
        this.val = val;
        this.dir = dir;
        this.parent = parent;
        this.children = [];
        this.boxes = 0;
        this.avoidThis = false;
        this.attackThis = false;
        this.bonusPoints = bonusPoints;
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
        this.rottenBoxes = new Set();
        this.gameLock = true;
        this.endGame = false;

        this.allLeaves = new Map();
        this.gstTargets = [];

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
                    } else if (this.endGame && this.haveEditableEggs) {
                        this.goEatSomeEggs();
                    } else if (this.canBomb) {
                        this.goBomb();
                    } else if (this.haveEditableEggs) {
                        this.goEatSomeEggs();
                    }
                }
                this.gameLock = false;
            }
        }

        gameLoop();
    }

    parseTicktack(id, res) {
        //console.log(id, res);
        const mapInfo = res.map_info;
        this.tickId = this.tickId + 1;
        this.map = mapInfo.map;
        this.flatMap = this.map.flat();
        this.mapWidth = mapInfo.size.cols;
        this.mapHeight = mapInfo.size.rows;
        const currentPlayer = mapInfo.players.find(p => p.id === this.playerId);
        this.player = new GamePlayer(this, currentPlayer);
        const opponents = mapInfo.players.filter(p => p.id !== this.playerId);
        this.opponentPositions = new Set();
        for (let opponent of opponents) {
            const p = opponent.currentPosition;
            this.opponentPositions.add(this.to1dPos(p.col, p.row));
        }
        this.playerMap = new Map();
        for (let player of mapInfo.players) {
            this.playerMap.set(player.id, player);
        }
        this.playerGst = null;
        this.targetGst = null;
        for (let gstEgg of mapInfo.dragonEggGSTArray) {
            if (gstEgg.id !== this.playerId) {
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
        for (let bomb of mapInfo.bombs) {
            const bombPos = this.to1dPos(bomb.col, bomb.row);
            const bombSpots = this.getBombSpots(bombPos, bomb.playerId);
            this.bombSpots = new Set([...this.bombSpots, ...bombSpots]);
            if (bomb.remainTime < 1000) {
                this.bombDangers = new Set([...this.bombDangers, ...bombSpots]);
            }
        }

        // update game state
        if (!this.gameStart) {
            this.canMove = true;
            this.gameLock = false;
        }
        const playerPosition = this.player.position;
        this.indanger = this.bombSpots.has(playerPosition);
        const canBomb = mapInfo.bombs.filter(b => b.playerId === this.playerId).length === 0;
        if (canBomb) {
            this.canBomb = canBomb;
        }
        this.haveEditableEggs = this.eggs.size > 0;
        this.endGame = this.flatMap.filter(c => c === 2).length <= 5;
        this.updateMap(res.tag, res.player_id);

        this.gameStart = true;

        this.run();
    }

    updateMap(tag, player_id) {
        if (player_id === this.playerId) {
            //console.log(tag);
            if (tag === 'player:stop-moving') {
            } else if (tag === 'player:moving-banned') {
                if (this.canMoveHandler) {
                    clearTimeout(this.canMoveHandler);
                    this.canMoveHandler = null;
                }
                this.canMove = true;
            } else if (tag === 'bomb:setup') {
                this.canBomb = false;
                const delay = 2000;
                setTimeout(() => this.canBomb = true, delay + 50);
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
        if (path) {
            //for (let [pos, leaf] of allLeaves) {
            this.drivePlayer(path);
        }
    }

    goBomb() {
        const root = new TreeNode(this.player.position, null, null);
        this.getAllLeaves(root, this.flatMap);
        let rickLeaf = null;
        let limit = 10;
        for (let [pos, leaf] of this.allLeaves) {
            const points = leaf.boxes + leaf.bonusPoints;
            if (!rickLeaf || (rickLeaf.boxes + rickLeaf.bonusPoints) < points) {
                rickLeaf = leaf;
            }
            if (--limit <= 0) {
                break;
            }
        }
        let pathToGSTEgg = null;
        for (let node of this.gstTargets) {
            pathToGSTEgg = node;
            break;
        }
        let extendPath;
        let standNode = null;
        if (rickLeaf) {
            standNode = rickLeaf;
        } else if (pathToGSTEgg) {
            standNode = pathToGSTEgg;
        }
        if (standNode) {
            const node = new TreeNode(standNode.val, null, null);
            extendPath = this.getAvoidBomb(node, this.flatMap, new Set([
                ...this.getBombSpots(standNode.val, this.playerId),
                ...this.bombSpots,
            ]));
        }
        if (extendPath) {
            extendPath = getPathFromRoot(extendPath);
        } else {
            extendPath = '';
        }
        //for (let [pos, leaf] of allLeaves) {
        if (standNode) {
            const direction = getPathFromRoot(standNode);
            console.log('direction', direction, extendPath);
            const lastPathLen = (direction + extendPath).length;
            this.drivePlayer(direction + 'b' + extendPath);
        }
    }

    goEatSomeEggs() {
        console.log('Go eat some eggs');
        const root = new TreeNode(this.player.position, null, null);
        let node = this.getEdiableEggsPath(root, this.flatMap);
        let path = '';
        if (node) {
            //console.log('extend path', extendPath);
            path = getPathFromRoot(node);
        }
        const pathLen = path.length;
        if (!this.endGame && pathLen > 5) {
            return;
        }
        //for (let [pos, leaf] of allLeaves) {
        if (path) {
            this.drivePlayer(path);
        }
    }

    getBombSpots(pos, playerId) {
        let playerPower = 3;
        const player = this.playerMap.get(playerId);
        if (player) {
            playerPower = player.power;
        }
        const passThroughCells = new Set([0, 3]);
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
        const playerPower = this.playerMap.get(this.playerId).power;
        let box1 = 0, box2 = 0, box3 = 0, box4 = 0;
        let boxes = 0;
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
                    boxes += 1;
                    break;
                }
            }
        }
        node.boxes = boxes;
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

    getAvoidBomb(startNode, map, bombSpots) {
        const goodSpots = new Set();
        let limit = 15;
        this.scanMap(startNode, map, (currentNode) => {
            if (!bombSpots.has(currentNode.val)) {
                if (this.eggs.has(currentNode.val)) {
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
        });

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
            const points = spot.boxes + spot.bonusPoints;
            if ((goodSpot.boxes + goodSpot.bonusPoints) < points) {
            }
        }
        console.log('count good spots', goodSpots.size);
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
                if (cellValue === 0) {
                    //console.log('get cell can move', neighbor);
                    if (this.opponentPositions.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (this.mystics.has(neighbor)) {
                        visited.add(neighbor);
                    }
                    if (this.bombDangers.has(neighbor)) {
                        visited.add(neighbor);
                    }
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

    drivePlayer(path, node) {
        const pathLen = path.split('').filter(c => c !== 'b').length;
        this.socket.emit('drive player', { direction: path });
        this.canMove = false;
        this.canMoveHandler = setTimeout(() => this.canMove = true, 250 * pathLen);
    }
}

exports.GameMap = GameMap;
