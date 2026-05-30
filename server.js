const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const DEBUG_GAME = process.env.DEBUG_GAME === '1';
const debugLog = (...args) => { if (DEBUG_GAME) console.log(...args); };

function cleanText(value, maxLength, fallback = '') {
    const text = String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
    return text || fallback;
}
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 3000,
    upgradeTimeout: 20000,
    maxHttpBufferSize: 1e6,
    perMessageDeflate: false,
    transports: ['websocket', 'polling']
});

// ==================== CONFIGURATION ====================
const CONFIG = {
    MAX_PLAYERS: 16,
    UPDATE_RATE: 20, // ms (50 updates per second) - HIGH FREQUENCY FOR REAL-TIME
    MATCH_DURATION: 360, // 6 minutes in seconds for FFA
    KILL_LIMIT: 999, // Disabled for FFA (use time limit instead)
    SPAWN_PROTECTION: 5000, // 5 seconds invincibility
    RESPAWN_DELAY: 2000, // 2 seconds respawn delay
    MAX_SPEED: 30, // Max player speed (increased for fast-paced gameplay)
    MAP_BOUNDS: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    WEAPONS: {
        assault_rifle: { damage: 25, range: 100, fireRate: 100 },
        shotgun: { damage: 15, range: 30, fireRate: 660, pellets: 8 },
        sniper: { damage: 100, range: 200, fireRate: 1250 },
        smg: { damage: 15, range: 60, fireRate: 66 },
        pistol: { damage: 20, range: 50, fireRate: 250 },
        rpg: { damage: 150, range: 150, fireRate: 2000, explosive: true },
        melee: { damage: 55, range: 4, fireRate: 400 }
    },
    SPAWN_POINTS: {
        // Red team spawns on the RIGHT side of the map (positive X)
        red: [{ x: 85, y: 1.7, z: -20 }, { x: 85, y: 1.7, z: 0 }, { x: 85, y: 1.7, z: 20 },
        { x: 90, y: 1.7, z: -20 }, { x: 90, y: 1.7, z: 0 }, { x: 90, y: 1.7, z: 20 }],
        // Blue team spawns on the LEFT side of the map (negative X)
        blue: [{ x: -85, y: 1.7, z: -20 }, { x: -85, y: 1.7, z: 0 }, { x: -85, y: 1.7, z: 20 },
        { x: -90, y: 1.7, z: -20 }, { x: -90, y: 1.7, z: 0 }, { x: -90, y: 1.7, z: 20 }],
        // FFA spawns scattered around safe areas (avoiding buildings at 0,0; -50,20; 50,-15; -45,-40; 55,40)
        ffa: [
            { x: -80, y: 1.7, z: 50 }, { x: 80, y: 1.7, z: -50 }, // Far corners
            { x: 0, y: 1.7, z: 60 }, { x: 0, y: 1.7, z: -60 },    // Mid North/South
            { x: -25, y: 1.7, z: -60 }, { x: 25, y: 1.7, z: 60 }, // Diagonal mids
            { x: 75, y: 1.7, z: 75 }, { x: -75, y: 1.7, z: -75 }, // Outer corners
            { x: -20, y: 1.7, z: 35 }, { x: 20, y: 1.7, z: -35 }  // Inner safe zones
        ]
    }
};

// Serve static files
app.use(express.static(__dirname));

// ==================== GAME STATE ====================
const gameState = {
    players: {},
    matchStartTime: Date.now(),
    matchEndTime: Date.now() + CONFIG.MATCH_DURATION * 1000,
    matchActive: false,
    messages: [],
    killfeed: [],
    teamScores: { red: 0, blue: 0 },
    drops: {}
};

// Track changes for delta updates
const changedPlayers = new Set();

// Store position history for lag compensation (last 1 second)
const positionHistory = {};

// ==================== HELPER FUNCTIONS ====================
function getRandomSpawn(team) {
    // Ensure team is properly set, default to assigning a team if ffa/none
    let teamName = team;
    if (!teamName || teamName === undefined || teamName === null) {
        // If NO team is specified at all, picking random for safety, but usually client sends 'ffa'
        teamName = 'ffa';
    }

    // Check if we have spawns for this team (red, blue, ffa)
    let spawns = CONFIG.SPAWN_POINTS[teamName];

    // Fallback logic
    if (!spawns && teamName === 'ffa') {
        // If for some reason ffa keys are missing, fallback to random red/blue
        const randTeam = Math.random() > 0.5 ? 'red' : 'blue';
        spawns = CONFIG.SPAWN_POINTS[randTeam];
    }

    if (!spawns || spawns.length === 0) {
        console.warn(`[SPAWN] Invalid team: ${teamName}, using red as fallback`);
        return { ...CONFIG.SPAWN_POINTS.red[0] };
    }

    // Filter for safe spawn points (nobody within 6 units)
    // Also calculate min distance to any player for each spawn to find the "safest" bad option
    const spawnOptions = spawns.map(spawn => {
        let minDistance = 9999;
        for (const playerId in gameState.players) {
            const p = gameState.players[playerId];
            if (!p || p.health <= 0) continue; // Ignore dead players
            const dist = Math.sqrt(Math.pow(p.x - spawn.x, 2) + Math.pow(p.z - spawn.z, 2));
            if (dist < minDistance) minDistance = dist;
        }
        return { ...spawn, minDistance };
    });

    // Strategy 1: Pick from safe spawns (distance >= 6)
    const safeSpawns = spawnOptions.filter(s => s.minDistance >= 6);

    let selectedSpawn;
    if (safeSpawns.length > 0) {
        selectedSpawn = safeSpawns[Math.floor(Math.random() * safeSpawns.length)];
    } else {
        // Strategy 2: Fallback - Pick the spawn with the largest distance to nearest player
        // Sort descending by minDistance
        spawnOptions.sort((a, b) => b.minDistance - a.minDistance);
        // Pick top 1 or 2 to maintain some randomness
        const bestOptions = spawnOptions.slice(0, Math.min(2, spawnOptions.length));
        selectedSpawn = bestOptions[Math.floor(Math.random() * bestOptions.length)];
    }

    // Apply random offset to prevent exact stacking (jitter)
    const jitter = 1.5;
    return {
        x: selectedSpawn.x + (Math.random() * jitter * 2 - jitter),
        y: selectedSpawn.y,
        z: selectedSpawn.z + (Math.random() * jitter * 2 - jitter)
    };
}

function getMatchTimeRemaining() {
    if (!gameState.matchStartTime) return CONFIG.MATCH_DURATION;
    const elapsed = Math.floor((Date.now() - gameState.matchStartTime) / 1000);
    return Math.max(0, CONFIG.MATCH_DURATION - elapsed);
}

function getPlayerState(player) {
    if (!player) return null;
    return {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        z: player.z,
        rotation: player.rotation,
        health: player.health,
        kills: player.kills,
        deaths: player.deaths,
        ping: player.ping,
        weapon: player.weapon,
        team: player.team,
        spawnProtected: Date.now() < player.spawnProtectionUntil
    };
}

function validatePosition(player, pos, deltaTime) {
    if (!player || !pos) return false;

    // Safety: If it's been a long time or first few updates, allow larger jumps (teleport sync)
    player.updateCount = (player.updateCount || 0) + 1;
    if (player.updateCount < 10) return true;

    const distance = Math.sqrt(
        Math.pow(pos.x - player.x, 2) +
        Math.pow(pos.z - player.z, 2)
    );

    // Allow up to 50 units/sec with 3x lag buffer for real-time responsiveness
    const maxSpeed = 50;
    const maxDistance = maxSpeed * (deltaTime / 1000) * 3;

    // Teleport threshold: If jump is massive (> 100 units), assume it's a sync/teleport and allow it
    if (distance > 100) {
        debugLog(`[NET] Player ${player.name} teleported ${distance.toFixed(1)} units`);
        return true;
    }

    return distance <= maxDistance;
}

function storePositionHistory(playerId, position) {
    if (!positionHistory[playerId]) {
        positionHistory[playerId] = [];
    }
    positionHistory[playerId].push({
        position: { ...position },
        timestamp: Date.now()
    });
    // Keep only last 1 second of history
    const cutoff = Date.now() - 1000;
    positionHistory[playerId] = positionHistory[playerId].filter(p => p.timestamp > cutoff);
}

function getPositionAtTime(playerId, timestamp) {
    const history = positionHistory[playerId];
    if (!history || history.length === 0) return null;

    // Find closest position to timestamp
    let closest = history[0];
    for (const entry of history) {
        if (Math.abs(entry.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp)) {
            closest = entry;
        }
    }
    return closest.position;
}

function validateShot(shooter, targetId, weaponType, shooterPing = 0) {
    const target = gameState.players[targetId];
    if (!target || target.health <= 0) return { valid: false };

    const weapon = CONFIG.WEAPONS[weaponType];
    if (!weapon) return { valid: false };

    // Get target position at time of shot (lag compensation)
    const shotTime = Date.now() - shooterPing;
    const targetPos = getPositionAtTime(targetId, shotTime) || { x: target.x, y: target.y, z: target.z };

    // Calculate distance
    const distance = Math.sqrt(
        Math.pow(shooter.x - targetPos.x, 2) +
        Math.pow(shooter.y - targetPos.y, 2) +
        Math.pow(shooter.z - targetPos.z, 2)
    );

    // Check if within weapon range (with tight tolerance for accuracy)
    const maxRange = weapon.range * 1.2; // 20% tolerance for minor lag
    if (distance > maxRange) {
        debugLog(`[VALIDATION] Shot rejected: Distance too high (${distance.toFixed(1)} > ${maxRange.toFixed(1)})`);
        return { valid: false, distance };
    }

    return { valid: true, distance };
}

function checkMatchEnd() {
    if (!gameState.matchActive) return;

    // For FFA: only check time limit, winner is determined by score
    // Check time limit
    if (getMatchTimeRemaining() <= 0) {
        // Find player with highest SCORE (kills * 100 - deaths * 25)
        let topPlayer = null;
        let topScore = -999999;

        for (const player of Object.values(gameState.players)) {
            const score = player.kills * 100 - player.deaths * 25;
            if (score > topScore) {
                topScore = score;
                topPlayer = player;
            }
        }

        console.log(`[MATCH] Time limit reached! Winner: ${topPlayer?.name} with score ${topScore}`);
        endMatch(topPlayer?.id);
    }
}

function startMatch() {
    gameState.matchStartTime = Date.now();
    gameState.matchActive = true;
    gameState.killfeed = [];

    // Reset all player stats
    for (const player of Object.values(gameState.players)) {
        player.kills = 0;
        player.deaths = 0;
        player.health = 100;
        // Use player's current team for spawn location
        const spawn = getRandomSpawn(player.team);
        player.x = spawn.x;
        player.y = spawn.y;
        player.z = spawn.z;
        player.spawnProtectionUntil = Date.now() + CONFIG.SPAWN_PROTECTION;
        changedPlayers.add(player.id);
    }

    gameState.matchActive = true;
    const serializedPlayers = {};
    for (const [id, p] of Object.entries(gameState.players)) {
        serializedPlayers[id] = getPlayerState(p);
    }
    io.emit('matchStart', {
        duration: CONFIG.MATCH_DURATION,
        killLimit: CONFIG.KILL_LIMIT,
        players: serializedPlayers
    });

    addToKillfeed('MATCH STARTED! GO GO GO!');
    console.log('Match started! Combat ENABLED.');
}

function endMatch(winnerId) {
    gameState.matchActive = false;
    gameState.matchEndTime = Date.now();

    const winner = gameState.players[winnerId];
    const stats = Object.values(gameState.players).map(p => ({
        id: p.id,
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        score: p.kills * 100 - p.deaths * 25
    })).sort((a, b) => b.score - a.score);

    io.emit('matchEnd', {
        winnerId,
        winnerName: winner?.name || 'Unknown',
        stats
    });

    console.log('Match ended! Winner:', winner?.name);

    // Auto-restart after 10 seconds
    setTimeout(() => {
        if (Object.keys(gameState.players).length > 0) {
            startMatch();
        }
    }, 10000);
}

function addToKillfeed(message) {
    const entry = { message, timestamp: Date.now() };
    gameState.killfeed.push(entry);
    if (gameState.killfeed.length > 10) gameState.killfeed.shift();
    io.emit('killfeed', entry);
}

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
    const playerCount = Object.keys(gameState.players).length;
    if (playerCount >= CONFIG.MAX_PLAYERS) {
        console.log('Server full, rejecting:', socket.id);
        socket.emit('serverFull');
        socket.disconnect(true);
        return;
    }

    console.log('Player connected:', socket.id, `(${playerCount + 1}/${CONFIG.MAX_PLAYERS})`);

    // Don't spawn yet - wait for team selection
    // Create player at origin temporarily
    gameState.players[socket.id] = {
        id: socket.id,
        name: 'Player',
        x: 0,
        y: 1.7,
        z: 0,
        rotation: 0,
        health: 100,
        kills: 0,
        deaths: 0,
        ping: 0,
        weapon: 'assault_rifle',
        lastUpdate: Date.now(),
        lastShootTime: 0,
        lastHitTime: 0,
        spawnProtectionUntil: Date.now() + CONFIG.SPAWN_PROTECTION,
        isSpectating: false,
        team: null // No team assigned yet
    };
    changedPlayers.add(socket.id);

    const serializedPlayers = {};
    for (const [id, p] of Object.entries(gameState.players)) {
        serializedPlayers[id] = getPlayerState(p);
    }

    // Send initial state
    socket.emit('init', {
        playerId: socket.id,
        players: serializedPlayers,
        config: {
            matchDuration: CONFIG.MATCH_DURATION,
            killLimit: CONFIG.KILL_LIMIT,
            weapons: CONFIG.WEAPONS,
            spawnProtection: CONFIG.SPAWN_PROTECTION
        },
        matchActive: gameState.matchActive,
        matchTimeRemaining: getMatchTimeRemaining(),
        messages: gameState.messages.slice(-50),
        drops: gameState.drops
    });

    // Notify others
    socket.broadcast.emit('playerJoined', getPlayerState(gameState.players[socket.id]));
    addToKillfeed(`${gameState.players[socket.id].name} joined the game`);

    // Start match if enough players and not already active
    const currentPlayerCount = Object.keys(gameState.players).length;
    if (!gameState.matchActive && currentPlayerCount >= 1) {
        startMatch();
    }

    // ===== SET PLAYER NAME =====
    socket.on('setName', (name) => {
        if (!gameState.players[socket.id]) return;
        const sanitizedName = cleanText(name, 16, 'Player');
        const player = gameState.players[socket.id];
        const oldName = player.name;
        player.name = sanitizedName;
        changedPlayers.add(socket.id);

        if (oldName !== sanitizedName) {
            addToKillfeed(`${oldName} is now ${sanitizedName}`);
        }
    });

    // ===== SET PLAYER TEAM =====
    socket.on('setTeam', (team) => {
        if (!gameState.players[socket.id]) return;
        const player = gameState.players[socket.id];
        if (team === 'red' || team === 'blue' || team === 'ffa') {
            const oldTeam = player.team;
            player.team = team;

            // Spawn player at team's spawn location
            const spawn = getRandomSpawn(team);
            player.x = spawn.x;
            player.y = spawn.y;
            player.z = spawn.z;
            player.health = 100;
            player.spawnProtectionUntil = Date.now() + CONFIG.SPAWN_PROTECTION;

            debugLog(`[TEAM] ${player.name} selected ${team} team, spawned at (${spawn.x}, ${spawn.z}) | HP: ${player.health}`);
            changedPlayers.add(socket.id);

            socket.emit('teamSelected', {
                team,
                x: spawn.x,
                y: spawn.y,
                z: spawn.z,
                spawnProtection: CONFIG.SPAWN_PROTECTION
            });
        }
    });

    // ===== PLAYER MOVEMENT =====
    socket.on('playerMovement', (data) => {
        try {
            const player = gameState.players[socket.id];
            if (!player || !data) return;

            const x = Math.max(CONFIG.MAP_BOUNDS.minX, Math.min(CONFIG.MAP_BOUNDS.maxX, Number(data.x) || 0));
            const y = Math.max(0, Math.min(50, Number(data.y) || 1.7));
            const z = Math.max(CONFIG.MAP_BOUNDS.minZ, Math.min(CONFIG.MAP_BOUNDS.maxZ, Number(data.z) || 0));
            const rotation = Number(data.rotation) || 0;

            // Validate movement speed (anti-cheat)
            const deltaTime = Date.now() - player.lastUpdate;
            if (deltaTime > 0 && !validatePosition(player, { x, z }, deltaTime)) {
                // log rejected movement occasionally
                if (Math.random() < 0.01) debugLog(`[NET] Movement rejected for ${player.name}`);
                return;
            }

            storePositionHistory(socket.id, { x, y, z });

            // Sync team if provided (supports red, blue, ffa)
            if (data.team && (data.team === 'red' || data.team === 'blue' || data.team === 'ffa')) {
                player.team = data.team;
            }

            const moved = Math.abs(player.x - x) > 0.01 ||
                Math.abs(player.y - y) > 0.01 ||
                Math.abs(player.z - z) > 0.01 ||
                Math.abs(player.rotation - rotation) > 0.01;

            if (moved) {
                player.x = x;
                player.y = y;
                player.z = z;
                player.rotation = rotation;
                player.lastUpdate = Date.now();
                changedPlayers.add(socket.id);
            }
        } catch (e) {
            console.error('Movement error:', e.message);
        }
    });

    // ===== WEAPON SWITCH =====
    socket.on('switchWeapon', (weaponType) => {
        const player = gameState.players[socket.id];
        if (!player) return;
        if (CONFIG.WEAPONS[weaponType]) {
            player.weapon = weaponType;
            changedPlayers.add(socket.id);
        }
    });

    // ===== PLAYER SHOOT =====
    socket.on('playerShoot', (data) => {
        try {
            const player = gameState.players[socket.id];
            debugLog(`[SHOOT] ${player?.name} fired | Health: ${player?.health} | Match: ${gameState.matchActive}`);

            if (!player || player.health <= 0) {
                debugLog(`[SHOOT] Invalid: player=${!!player}, health=${player?.health}`);
                return;
            }

            const weapon = CONFIG.WEAPONS[player.weapon];
            if (!weapon) {
                debugLog(`[SHOOT] No weapon: ${player.weapon}`);
                return;
            }

            const now = Date.now();
            if (now - player.lastShootTime < weapon.fireRate) {
                debugLog(`[SHOOT] Fire rate limited`);
                return;
            }
            player.lastShootTime = now;

            // Cancel Spawn Protection on shoot
            player.spawnProtectionUntil = 0;

            socket.broadcast.emit('playerShot', {
                playerId: socket.id,
                weapon: player.weapon
            });
        } catch (e) {
            console.error('Shoot error:', e.message);
        }
    });

    // ===== SERVER-SIDE HIT VALIDATION =====
    socket.on('playerHit', (data) => {
        try {
            const player = gameState.players[socket.id];
            if (!player || !data || !gameState.matchActive) {
                debugLog(`[HIT] Invalid: player=${!!player}, data=${!!data}, matchActive=${gameState.matchActive}`);
                return;
            }

            const { targetId, isHeadshot } = data;

            // 1. SELF DAMAGE CHECK
            if (targetId === socket.id) {
                debugLog(`[HIT] Self damage blocked`);
                return;
            }

            const target = gameState.players[targetId];
            if (!target) {
                debugLog(`[HIT] Target not found: ${targetId}`);
                return;
            }

            // 2. DEAD CHECK
            if (target.health <= 0 || player.health <= 0) {
                debugLog(`[HIT] Dead check failed: target.health=${target.health}, player.health=${player.health}`);
                return;
            }

            // 3. SPAWN PROTECTION
            if (Date.now() < target.spawnProtectionUntil) {
                socket.emit('hitBlocked', { reason: 'spawn_protection' });
                debugLog(`[HIT] Spawn protection active for ${target.name}`);
                return;
            }

            // 4. FRIENDLY FIRE CHECK
            if (player.team && target.team && player.team === target.team && player.team !== 'ffa') {
                debugLog(`[HIT] Friendly fire blocked: ${player.name} -> ${target.name}`);
                return;
            }

            debugLog(`[HIT] Accepted: ${player.name} (${player.team}) -> ${target.name} (${target.team})`);

            // 5. SERVER-SIDE HIT VALIDATION (Raycast/Distance Check)
            const validation = validateShot(player, targetId, player.weapon, player.ping);
            if (!validation.valid) {
                debugLog(`[HIT] Rejected by server (Range/Latency): ${player.name} -> ${target.name}`);
                return;
            }

            // 6. APPLY DAMAGE
            const weapon = CONFIG.WEAPONS[player.weapon];
            let damage = weapon.damage;
            if (isHeadshot) damage *= 2;

            // Randomize slightly to prevent exact number predicting
            damage = Math.floor(damage * (0.9 + Math.random() * 0.2));

            target.health = Math.max(0, target.health - damage);
            changedPlayers.add(targetId);

            debugLog(`[DAMAGE APPLIED] ${player.name} -> ${target.name} | Damage: ${damage} | Health: ${target.health}`);

            // Notify target
            io.to(targetId).emit('takeDamage', {
                attackerId: socket.id,
                attackerName: player.name,
                damage,
                isHeadshot,
                weapon: player.weapon,
                remainingHealth: target.health
            });

            // Confirm hit to shooter
            socket.emit('hitConfirmed', {
                targetId,
                damage,
                isHeadshot,
                targetHealth: target.health
            });

            // Check for kill
            if (target.health <= 0) {
                player.kills++;
                target.deaths++;
                changedPlayers.add(socket.id);

                debugLog(`[KILL] ${player.name} killed ${target.name} | Kills: ${player.kills}`);

                // Team Scoring
                if (player.team && gameState.teamScores[player.team] !== undefined) {
                    gameState.teamScores[player.team]++;
                    io.emit('teamScoreUpdate', gameState.teamScores);
                }

                const killMessage = isHeadshot
                    ? `${player.name} ⊕ ${target.name}`
                    : `${player.name} ➔ ${target.name}`;

                addToKillfeed(killMessage);

                io.emit('playerKilled', {
                    killerId: socket.id,
                    killerName: player.name,
                    victimId: targetId,
                    victimName: target.name,
                    weapon: player.weapon,
                    isHeadshot
                });

                // Spawn a loot drop at victim location
                const dropId = `drop_${Date.now()}_${targetId}`;
                const drop = {
                    id: dropId,
                    x: target.x,
                    y: 0.5, // Slight hover above ground
                    z: target.z,
                    spawnTime: Date.now()
                };
                gameState.drops[dropId] = drop;
                io.emit('dropSpawned', drop);

                // Remove drop after 30 seconds if not collected
                setTimeout(() => {
                    if (gameState.drops[dropId]) {
                        delete gameState.drops[dropId];
                        io.emit('dropCollected', { dropId, playerId: null });
                    }
                }, 30000);

                // Schedule respawn
                setTimeout(() => {
                    if (gameState.players[targetId] && gameState.matchActive) {
                        const spawn = getRandomSpawn(target.team);
                        target.health = 100;
                        target.x = spawn.x;
                        target.y = spawn.y;
                        target.z = spawn.z;
                        target.spawnProtectionUntil = Date.now() + CONFIG.SPAWN_PROTECTION;
                        changedPlayers.add(targetId);

                        io.to(targetId).emit('respawn', {
                            x: spawn.x,
                            y: spawn.y,
                            z: spawn.z,
                            spawnProtection: CONFIG.SPAWN_PROTECTION
                        });

                        // Immediately broadcast respawned player's position to all other players
                        io.emit('stateUpdate', {
                            [targetId]: getPlayerState(target)
                        });
                    }
                }, CONFIG.RESPAWN_DELAY);

                checkMatchEnd();
            }
        } catch (e) {
            console.error('Hit error:', e.message);
        }
    });

    // ===== PICKUP DROP =====
    socket.on('pickupDrop', (dropId) => {
        const player = gameState.players[socket.id];
        const drop = gameState.drops[dropId];

        if (player && player.health > 0 && drop) {
            debugLog(`[PICKUP] ${player.name} picked up ${dropId}`);

            // Delete drop from server state first to prevent double-pickup
            delete gameState.drops[dropId];

            // Restore health
            player.health = 100;
            changedPlayers.add(socket.id);

            // Notify all clients
            io.emit('dropCollected', { dropId, playerId: socket.id });
        }
    });

    // ===== CHAT MESSAGE =====
    socket.on('chatMessage', (message) => {
        try {
            const player = gameState.players[socket.id];
            if (!player || !message) return;

            const sanitizedMessage = cleanText(message, 200, '');
            if (!sanitizedMessage.trim()) return;

            const chatEntry = {
                playerId: socket.id,
                playerName: player.name,
                message: sanitizedMessage,
                timestamp: Date.now()
            };

            gameState.messages.push(chatEntry);
            if (gameState.messages.length > 100) gameState.messages.shift();

            io.emit('chatMessage', chatEntry);
        } catch (e) {
            console.error('Chat error:', e.message);
        }
    });

    // ===== PING =====
    socket.on('ping', () => socket.emit('pong'));

    socket.on('latency', (latency) => {
        if (gameState.players[socket.id] && typeof latency === 'number') {
            gameState.players[socket.id].ping = Math.max(0, Math.min(9999, latency));
        }
    });

    // ===== SPECTATE =====
    socket.on('spectate', (targetId) => {
        const player = gameState.players[socket.id];
        if (!player || player.health > 0) return;

        player.isSpectating = true;
        player.spectateTarget = targetId;

        if (gameState.players[targetId]) {
            socket.emit('spectateTarget', {
                targetId,
                targetName: gameState.players[targetId].name
            });
        }
    });

    // ===== DISCONNECT =====
    socket.on('disconnect', () => {
        const player = gameState.players[socket.id];
        if (player) {
            addToKillfeed(`${player.name} left the game`);
        }

        console.log('Player disconnected:', socket.id);
        // playerCount is now derived from Object.keys(gameState.players).length
        changedPlayers.delete(socket.id);
        delete gameState.players[socket.id];
        delete positionHistory[socket.id];

        io.emit('playerLeft', socket.id);
    });

    socket.on('error', (err) => {
        console.error('Socket error:', socket.id, err.message);
    });
});

// ==================== GAME LOOP ====================
// Broadcast state updates
setInterval(() => {
    if (changedPlayers.size > 0) {
        const update = {};
        changedPlayers.forEach(id => {
            if (gameState.players[id]) {
                update[id] = getPlayerState(gameState.players[id]);
            }
        });
        changedPlayers.clear();

        if (Object.keys(update).length > 0) {
            io.emit('stateUpdate', update);
        }
    }
}, CONFIG.UPDATE_RATE);

// Match timer broadcast
setInterval(() => {
    if (gameState.matchActive) {
        const remaining = getMatchTimeRemaining();
        io.emit('matchTimer', remaining);

        if (remaining <= 0) {
            checkMatchEnd();
        }
    }
}, 1000);

// Leaderboard update
setInterval(() => {
    const leaderboard = Object.values(gameState.players)
        .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, ping: p.ping }))
        .sort((a, b) => b.kills - a.kills)
        .slice(0, 10);

    io.emit('leaderboard', leaderboard);
}, 2000);

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Server info
app.get('/api/info', (req, res) => {
    res.json({
        players: Object.keys(gameState.players).length,
        maxPlayers: CONFIG.MAX_PLAYERS,
        matchActive: gameState.matchActive,
        matchTimeRemaining: getMatchTimeRemaining()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Tactical Strike Server running on port ${PORT}`);
    console.log(`   Max Players: ${CONFIG.MAX_PLAYERS}`);
    console.log(`   Match Duration: ${CONFIG.MATCH_DURATION}s`);
    console.log(`   Kill Limit: ${CONFIG.KILL_LIMIT}`);
});
