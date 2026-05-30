// ===== TACTICAL STRIKE - 3D FPS GAME =====
// Complete Game Implementation

const GAME_DEBUG = false;
const debugLog = (...args) => { if (GAME_DEBUG) console.log(...args); };
const debugWarn = (...args) => { if (GAME_DEBUG) console.warn(...args); };

// ==================== AUDIO MANAGER ====================
class AudioManager {
    constructor(game) {
        this.game = game;
        this.audioContext = null;
        this.masterGain = null;
        this.sounds = {};
        this.initialized = false;
        this.activeSounds = 0;
        this.init();
    }

    init() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            this.masterGain.gain.value = 0.7;
            this.sounds = {
                shoot: { frequency: 150, duration: 0.05, type: 'square', decay: 0.1 },
                shotgun: { frequency: 80, duration: 0.1, type: 'sawtooth', decay: 0.2 },
                sniper: { frequency: 200, duration: 0.08, type: 'square', decay: 0.3 },
                reload: { frequency: 400, duration: 0.1, type: 'sine', decay: 0.3 },
                hit: { frequency: 300, duration: 0.05, type: 'sine', decay: 0.1 },
                footstep: { frequency: 50, duration: 0.05, type: 'square', decay: 0.05 },
                explosion: { frequency: 60, duration: 0.3, type: 'sawtooth', decay: 0.4 },
                enemyShoot: { frequency: 120, duration: 0.04, type: 'square', decay: 0.08 },
                playerHit: { frequency: 200, duration: 0.1, type: 'sawtooth', decay: 0.2 },
                melee: { frequency: 600, duration: 0.03, type: 'sawtooth', decay: 0.08 }
            };
            this.initialized = true;
        } catch (e) {
            console.warn('Web Audio API not supported:', e);
        }
    }

    playSound(name, volume = 1) {
        if (!this.initialized || !this.sounds[name]) return;
        if (this.activeSounds > 25) return; // Limit concurrent sounds to prevent lag/crash

        if (this.audioContext.state === 'suspended') this.audioContext.resume();

        // Special whip crack sound for melee
        if (name === 'melee') {
            this.playWhipCrack(volume);
            return;
        }

        const sound = this.sounds[name];
        const now = this.audioContext.currentTime;
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();

        this.activeSounds++;

        oscillator.type = sound.type;
        oscillator.frequency.setValueAtTime(sound.frequency, now);
        oscillator.frequency.exponentialRampToValueAtTime(sound.frequency * 0.5, now + sound.duration + sound.decay);
        gainNode.gain.setValueAtTime(volume * 0.3, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + sound.duration + sound.decay);

        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        oscillator.start(now);

        const totalDuration = sound.duration + sound.decay;
        oscillator.stop(now + totalDuration + 0.1);

        oscillator.onended = () => {
            oscillator.disconnect();
            gainNode.disconnect();
            this.activeSounds--;
        };
    }

    playWhipCrack(volume = 1) {
        const now = this.audioContext.currentTime;
        this.activeSounds += 2;

        // Layer 1: White noise burst (the "crack")
        const bufferSize = this.audioContext.sampleRate * 0.08; // 80ms of noise
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3); // Sharp attack, fast decay
        }
        const noiseSource = this.audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        const noiseGain = this.audioContext.createGain();
        noiseGain.gain.setValueAtTime(volume * 0.5, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        // Highpass filter to make it sharp/snappy
        const highpass = this.audioContext.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 2000;

        noiseSource.connect(highpass);
        highpass.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        noiseSource.start(now);
        noiseSource.stop(now + 0.1);

        noiseSource.onended = () => {
            noiseSource.disconnect();
            highpass.disconnect();
            noiseGain.disconnect();
            this.activeSounds--;
        };

        // Layer 2: High-to-low frequency sweep (the "whip" swoosh)
        const osc = this.audioContext.createOscillator();
        const oscGain = this.audioContext.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(1800, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.06);
        oscGain.gain.setValueAtTime(volume * 0.15, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

        osc.connect(oscGain);
        oscGain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.1);

        osc.onended = () => {
            osc.disconnect();
            oscGain.disconnect();
            this.activeSounds--;
        };
    }

    play3DSound(name, position, listenerPosition, volume = 1) {
        if (!this.initialized) return;
        const distance = position.distanceTo(listenerPosition);
        const attenuation = Math.max(0, 1 - (distance / 50));
        this.playSound(name, volume * attenuation);
    }

    playAmbient() { }
    setVolume(v) { if (this.masterGain) this.masterGain.gain.value = v; }
}

// ==================== PHYSICS WORLD ====================
class PhysicsWorld {
    constructor(game) {
        this.game = game;
        this.colliders = []; // Static world colliders
        this.raycastTargets = [];
        this.gravity = -30;
        this.tempVector = new THREE.Vector3();
        this.tempBox = new THREE.Box3();
        this.tempMin = new THREE.Vector3();
        this.tempMax = new THREE.Vector3();
        this.raycaster = new THREE.Raycaster();
    }

    addCollider(mesh, type) {
        if (!mesh) return;
        mesh.updateMatrixWorld(true);
        if (mesh.geometry && !mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const box = new THREE.Box3().setFromObject(mesh);
        if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;

        const collider = {
            box,
            type,
            mesh,
            minX: box.min.x,
            maxX: box.max.x,
            minY: box.min.y,
            maxY: box.max.y,
            minZ: box.min.z,
            maxZ: box.max.z
        };
        this.colliders.push(collider);
        if (mesh.isMesh && mesh.visible !== false) this.raycastTargets.push(mesh);
    }

    removeCollider(mesh) {
        const index = this.colliders.findIndex(c => c.mesh === mesh);
        if (index > -1) this.colliders.splice(index, 1);
        const rayIndex = this.raycastTargets.indexOf(mesh);
        if (rayIndex > -1) this.raycastTargets.splice(rayIndex, 1);
    }

    update(deltaTime) {
        // Dynamic collider updates if needed
    }

    // Compatibility wrapper
    checkMovement(from, to, radius = 0.5) {
        return !this.checkCapsule(to, radius, 1.8);
    }

    // Check if a capsule at 'pos' with 'radius' and 'height' intersects the world
    checkCapsule(pos, radius, height) {
        const feetY = pos.y - (height - 0.2); // Feet position (approx)
        const headY = pos.y + 0.2; // Head position

        // Create a box approximation for the capsule for broad phase
        const minX = pos.x - radius;
        const maxX = pos.x + radius;
        const minY = feetY;
        const maxY = headY;
        const minZ = pos.z - radius;
        const maxZ = pos.z + radius;
        this.tempMin.set(minX, minY, minZ);
        this.tempMax.set(maxX, maxY, maxZ);
        this.tempBox.set(this.tempMin, this.tempMax);

        for (const c of this.colliders) {
            if (maxX < c.minX || minX > c.maxX || maxY < c.minY || minY > c.maxY || maxZ < c.minZ || minZ > c.maxZ) {
                continue;
            }
            if (this.tempBox.intersectsBox(c.box)) {
                return true;
            }
        }
        return false;
    }

    resolveCollision(position, deltaMove, radius = 0.4, height = 1.8) {
        const startPos = position.clone();
        const finalVelocity = deltaMove.clone();

        const steps = Math.max(1, Math.min(3, Math.ceil(deltaMove.length() / 0.35)));
        const stepMove = deltaMove.clone().divideScalar(steps);

        let currentPos = startPos.clone();

        for (let i = 0; i < steps; i++) {
            // Try moving X
            const testX = currentPos.clone();
            testX.x += stepMove.x;
            if (!this.checkCapsule(testX, radius, height)) {
                currentPos.x = testX.x;
            } else {
                finalVelocity.x = 0;
            }

            // Try moving Z
            const testZ = currentPos.clone();
            testZ.z += stepMove.z;
            if (!this.checkCapsule(testZ, radius, height)) {
                currentPos.z = testZ.z;
            } else {
                finalVelocity.z = 0;
            }

            // Try moving Y (Vertical) - Simple gravity/jump
            const testY = currentPos.clone();
            testY.y += stepMove.y;

            // Check Collision
            if (this.checkCapsule(testY, radius, height)) {
                // Collision on Y
                finalVelocity.y = 0;

                // STAIR STEPPING LOGIC
                // If we were moving horizontally and hit something low, try to step up
                if (Math.abs(stepMove.x) > 0 || Math.abs(stepMove.z) > 0) {
                    const stepHeight = 0.5; // Max step height
                    const testStep = currentPos.clone();
                    testStep.y += stepHeight;
                    testStep.x += stepMove.x;
                    testStep.z += stepMove.z;

                    // If we can move at the higher position...
                    if (!this.checkCapsule(testStep, radius, height)) {
                        // We found a step! Interpolate up
                        currentPos.y += 0.1; // Smooth step up
                        currentPos.x += stepMove.x;
                        currentPos.z += stepMove.z;
                    }
                }
            } else {
                currentPos.y = testY.y;
            }
        }

        // Anti-Stuck: If we ended up inside a wall, push out
        if (this.checkCapsule(currentPos, radius, height)) {
            // Try pushing back to start
            currentPos.copy(startPos);
        }

        // Ground clamping optimization
        // ...

        return { position: currentPos, velocity: finalVelocity };
    }

    raycast(origin, direction, maxDistance = 200, ignoreList = []) {
        this.raycaster.set(origin, direction.normalize());
        this.raycaster.far = maxDistance;

        // Fix for Sprites (needs camera to be set)
        if (this.game.renderer && this.game.renderer.camera) {
            this.raycaster.camera = this.game.renderer.camera;
        }

        let intersects = this.raycaster.intersectObjects(this.raycastTargets, false);

        if (this.game.networkManager && this.game.networkManager.remotePlayers) {
            const playerMeshes = [];
            const remotePlayers = this.game.networkManager.remotePlayers;
            for (const id in remotePlayers) {
                const p = remotePlayers[id];
                if (p && p.mesh && p.health > 0 && !p.isDestroying) playerMeshes.push(p.mesh);
            }
            if (playerMeshes.length) {
                intersects = intersects.concat(this.raycaster.intersectObjects(playerMeshes, true));
                intersects.sort((a, b) => a.distance - b.distance);
            }
        }

        // Filter ignore list
        const validHits = intersects.filter(hit => {
            // Traverse up to find root object if needed
            let obj = hit.object;
            while (obj.parent && obj.parent.type !== 'Scene') {
                if (ignoreList.includes(obj)) return false;
                obj = obj.parent;
            }
            return !ignoreList.includes(hit.object);
        });

        if (validHits.length > 0) {
            const hit = validHits[0];

            // Determine if it's a player
            let isPlayer = false;
            let playerObj = null;
            let obj = hit.object;
            while (obj) {
                if (obj.userData && (obj.userData.isPlayer || obj.userData.type === 'remotePlayer')) {
                    isPlayer = true;
                    playerObj = obj; // This might be a child, we need the root or just the hit
                    // actually playerObj in my logic was used for position. 
                    // If 'obj' is a child (arm), obj.parent might be the group.
                    // RemotePlayer root mesh is 'this.mesh'.
                    // The children have user data.
                    // I need to traverse up to find the root to get the 'position' pivot.
                    // or just use the HIT POINT relative to the root?

                    // Let's find the root 'Group' which has the position
                    let root = obj;
                    while (root.parent && root.parent.type !== 'Scene') root = root.parent;
                    playerObj = root;
                    break;
                }
                obj = obj.parent;
            }

            if (isPlayer) {
                // Precise Hitbox Detection
                // Head is top 15% of the mesh bounding box
                const yRel = hit.point.y - playerObj.position.y;
                const isHeadshot = yRel > 1.35; // Approx head height relative to pivot (feet or center)
                // Note: Player pivot is usually feet. If eyes are 1.7, head is 1.6-1.9.

                return {
                    object: playerObj,
                    point: hit.point,
                    distance: hit.distance,
                    isPlayer: true,
                    isHeadshot: isHeadshot
                };
            }

            return hit;
        }

        return null;
    }

    getGroundHeight(x, z) {
        // Raycast down from high up
        this.raycaster.set(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0));
        const hits = this.raycaster.intersectObjects(this.raycastTargets, false);
        if (hits.length > 0) return hits[0].point.y;
        return 0;
    }
}

// Optimization Helper: Deep dispose of Three.js objects
function disposeObject(obj) {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach(m => {
            if (m.map) m.map.dispose();
            if (m.lightMap) m.lightMap.dispose();
            if (m.bumpMap) m.bumpMap.dispose();
            if (m.normalMap) m.normalMap.dispose();
            if (m.specularMap) m.specularMap.dispose();
            if (m.envMap) m.envMap.dispose();
            m.dispose();
        });
    }
    if (obj.children) {
        obj.children.forEach(disposeObject);
    }
}

function tuneMaterial(material, profile = 'world', contextName = '') {
    if (!material) return;

    const materials = Array.isArray(material) ? material : [material];
    const name = `${contextName} ${material.name || ''}`.toLowerCase();

    materials.forEach((mat) => {
        if (!mat) return;

        if (mat.map) {
            mat.map.encoding = THREE.sRGBEncoding;
            mat.map.anisotropy = 8;
        }

        if ('roughness' in mat) {
            const baseRoughness = profile === 'weapon' ? 0.32 : 0.72;
            mat.roughness = Math.min(Math.max(mat.roughness ?? baseRoughness, 0.22), 0.92);
        }

        if ('metalness' in mat) {
            const metalHint = /metal|steel|iron|weapon|gun|barrel|blade|rail/.test(name);
            if (profile === 'weapon' || metalHint) {
                mat.metalness = Math.max(mat.metalness ?? 0.45, 0.45);
                if ('roughness' in mat) mat.roughness = Math.min(mat.roughness ?? 0.35, 0.48);
            } else {
                mat.metalness = Math.min(mat.metalness ?? 0.08, 0.18);
            }
        }

        if (/glass|window|windscreen/.test(name)) {
            if ('metalness' in mat) mat.metalness = 0.05;
            if ('roughness' in mat) mat.roughness = 0.08;
            mat.transparent = true;
            mat.opacity = Math.min(mat.opacity ?? 0.72, 0.72);
        }

        if ('envMapIntensity' in mat) {
            mat.envMapIntensity = profile === 'weapon' ? 0.95 : 0.55;
        }

        if ('emissive' in mat && /light|lamp|neon|screen|scope/.test(name)) {
            mat.emissive = mat.emissive || new THREE.Color(0x000000);
            mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 0, 0.35);
        }

        mat.needsUpdate = true;
    });
}

function tuneObjectSurface(object, profile = 'world') {
    if (!object) return;
    object.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;
        tuneMaterial(child.material, profile, child.name || object.name || '');
    });
}

function createSoftParticleTexture(inner = 'rgba(255, 230, 180, 1)', outer = 'rgba(255, 230, 180, 0)') {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    gradient.addColorStop(0, inner);
    gradient.addColorStop(0.35, inner.replace(', 1)', ', 0.55)'));
    gradient.addColorStop(1, outer);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    return texture;
}

function createIndustrialTexture(base = '#5c5d58', line = '#333833', accent = '#9b7f58') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 256, 256);

    for (let i = 0; i < 900; i++) {
        const shade = 35 + Math.floor(Math.random() * 32);
        ctx.fillStyle = `rgba(${shade}, ${shade}, ${shade}, ${0.04 + Math.random() * 0.05})`;
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }

    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    for (let x = 0; x <= 256; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 256);
        ctx.stroke();
    }
    for (let y = 0; y <= 256; y += 32) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(256, y);
        ctx.stroke();
    }

    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(18, 238);
    ctx.lineTo(238, 18);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    return texture;
}

// ==================== WEAPON ====================
class Weapon {
    constructor(game, type, config) {
        this.game = game;
        this.type = type;
        this.name = config.name;
        this.damage = config.damage;
        this.fireRate = config.fireRate;
        this.magSize = config.magSize;
        this.maxReserve = config.reserveAmmo;
        this.reloadTime = config.reloadTime;
        this.spread = config.spread;
        this.range = config.range;
        this.automatic = config.automatic;
        this.pellets = config.pellets || 1;
        this.currentAmmo = this.magSize;
        this.reserveAmmo = this.maxReserve;
        this.lastFireTime = 0;
        this.isReloading = false;
        this.mesh = null;
        this.muzzleFlash = null;
        this.muzzleLight = null;
        this.meleeSwing = 0;
        this.shurikenVisual = null;
        // Switch animation state
        this.switchAnim = 'none'; // 'none', 'putting_away', 'pulling_out'
        this.switchAnimProgress = 0;
        this.restPosition = { x: 0.25, y: -0.3, z: -0.5 };
    }

    createModel() {
        this.mesh = new THREE.Group();
        const matBlack = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.8 });
        const matGrey = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.7 });
        const matWood = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.8, metalness: 0.1 });
        const matGreen = new THREE.MeshStandardMaterial({ color: 0x3d4a36, roughness: 0.7, metalness: 0.2 });
        const matSteel = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.2, metalness: 1.0 });

        // helper to add parts
        const addPart = (geom, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
            const m = new THREE.Mesh(geom, mat);
            m.position.set(x, y, z);
            m.rotation.set(rx, ry, rz);
            m.castShadow = true;
            this.mesh.add(m);
            return m;
        };

        switch (this.type) {
            case 'assault_rifle':
                // Load AK47 GLB model
                const ak47Loader = new THREE.GLTFLoader();
                ak47Loader.load('assets/guns/ak47_2.glb', (gltf) => {
                    const ak47Model = gltf.scene;
                    // FPS Viewmodel settings - adjust these values to fine-tune
                    ak47Model.scale.set(0.3, 0.3, 0.3); // Much smaller scale for FPS view
                    ak47Model.position.set(-0.04, -0.09, 0); // x=right, y=down, z=forward
                    ak47Model.rotation.set(0.1, -1.4, 0); // Rotate so barrel points forward (-Z)
                    ak47Model.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    tuneObjectSurface(ak47Model, 'weapon');
                    this.mesh.add(ak47Model);
                }, undefined, (error) => {
                    console.error('Error loading AK47 model:', error);
                });
                break;

            case 'shotgun':
                // Load Shotgun GLB model
                const shotgunLoader = new THREE.GLTFLoader();
                shotgunLoader.load('assets/guns/shotgun.glb', (gltf) => {
                    const shotgunModel = gltf.scene;
                    // FPS Viewmodel settings - adjust these values to fine-tune
                    shotgunModel.scale.set(0.4, 0.4, 0.4); // Much smaller scale for FPS view
                    shotgunModel.position.set(-0.01, -0.03, 0); // x=right, y=down, z=forward
                    shotgunModel.rotation.set(0, 1.75, 0.1); // Rotate so barrel points forward (-Z)
                    shotgunModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    tuneObjectSurface(shotgunModel, 'weapon');
                    this.mesh.add(shotgunModel);
                }, undefined, (error) => {
                    console.error('Error loading Shotgun model:', error);
                });
                break;

            case 'sniper':
                // Load Sniper GLB model
                const awmLoader = new THREE.GLTFLoader();
                awmLoader.load('assets/guns/awp.glb', (gltf) => {
                    const awmModel = gltf.scene;
                    // FPS Viewmodel settings - adjust these values to fine-tune
                    awmModel.scale.set(0.2, 0.2, 0.2); // Much smaller scale for FPS view
                    awmModel.position.set(-0.03, -0.05, -0.35); // x=right, y=down, z=forward
                    awmModel.rotation.set(0, -1.5, 0); // Rotate so barrel points forward (-Z)
                    awmModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    tuneObjectSurface(awmModel, 'weapon');
                    this.mesh.add(awmModel);
                }, undefined, (error) => {
                    console.error('Error loading Sniper model:', error);
                });
                break;


            case 'smg':
                // Load Sniper GLB model
                const smgLoader = new THREE.GLTFLoader();
                smgLoader.load('assets/guns/smg.glb', (gltf) => {
                    const smgModel = gltf.scene;
                    // FPS Viewmodel settings - adjust these values to fine-tune
                    smgModel.scale.set(2.8, 2.8, 2.8); // Much smaller scale for FPS view
                    smgModel.position.set(-0.03, -0.05, -0.3); // x=right, y=down, z=forward
                    smgModel.rotation.set(0, 0.1, 0); // Rotate so barrel points forward (-Z)
                    smgModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    tuneObjectSurface(smgModel, 'weapon');
                    this.mesh.add(smgModel);
                }, undefined, (error) => {
                    console.error('Error loading SMG model:', error);
                });
                break;

            case 'pistol':
                // Load Sniper GLB model
                const deagleLoader = new THREE.GLTFLoader();
                deagleLoader.load('assets/guns/deagle.glb', (gltf) => {
                    const deagleModel = gltf.scene;
                    // FPS Viewmodel settings - adjust these values to fine-tune
                    deagleModel.scale.set(0.11, 0.11, 0.11); // Much smaller scale for FPS view
                    deagleModel.position.set(-0.13, 0.1, -0.2); // x=right, y=down, z=forward
                    deagleModel.rotation.set(0.1, -2.9, 0); // Rotate so barrel points forward (-Z)
                    deagleModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    tuneObjectSurface(deagleModel, 'weapon');
                    this.mesh.add(deagleModel);
                }, undefined, (error) => {
                    console.error('Error loading Pistol model:', error);
                });
                break;

            case 'rpg':
                // Load Sniper GLB model
                const rpgLoader = new THREE.GLTFLoader();
                rpgLoader.load('assets/guns/rpg.glb', (gltf) => {
                    const rpgModel = gltf.scene;
                    // FPS Viewmodel settings - adjust these values to fine-tune
                    rpgModel.scale.set(13, 13, 13); // Much smaller scale for FPS view
                    rpgModel.position.set(-0.06, 0.04, 0); // x=right, y=down, z=forward
                    rpgModel.rotation.set(0, -3, 0); // Rotate so barrel points forward (-Z)
                    rpgModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    tuneObjectSurface(rpgModel, 'weapon');
                    this.mesh.add(rpgModel);
                }, undefined, (error) => {
                    console.error('Error loading RPG model:', error);
                });
                break;

            case 'melee':
                this.shurikenVisual = this.createShurikenModel(0.34);
                this.shurikenVisual.position.set(-0.03, -0.04, -0.12);
                this.shurikenVisual.rotation.set(0.15, 0.05, -0.2);
                this.mesh.add(this.shurikenVisual);
                break;
        }

        // --- Muzzle Flash (Hidden by default, skip for melee) ---
        if (this.type !== 'melee') {
            const isRPG = this.type === 'rpg';
            const flashGeom = new THREE.ConeGeometry(isRPG ? 0.25 : 0.1, isRPG ? 0.6 : 0.3, 8);
            const flashMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0 });
            this.muzzleFlash = new THREE.Mesh(flashGeom, flashMat);
            this.muzzleFlash.rotation.x = Math.PI / 2;
            this.muzzleFlash.position.x = -0.15;
            this.muzzleFlash.position.z = isRPG ? -1.0 : -1.4;
            this.mesh.add(this.muzzleFlash);

            this.muzzleLight = new THREE.PointLight(0xffb347, 0, isRPG ? 6 : 3, 2);
            this.muzzleLight.position.copy(this.muzzleFlash.position);
            this.mesh.add(this.muzzleLight);
        }

        // --- ARMS (Visual Only) ---
        const skinMat = new THREE.MeshStandardMaterial({ color: 0xdcb887, roughness: 0.8 });
        const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1.0 });

        const rightArm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.6, 8), sleeveMat);
        rightArm.rotation.set(-Math.PI / 4, 0, -0.2);
        rightArm.position.set(0.15, -0.25, 0.15);
        this.mesh.add(rightArm);

        const leftArm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.6, 8), sleeveMat);
        leftArm.rotation.set(-Math.PI / 2.5, 0, 0.5);
        leftArm.position.set(-0.2, -0.3, -0.05);
        this.mesh.add(leftArm);

        // Hand Boxes
        const handR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), skinMat);
        handR.position.set(0, -0.05, 0.12); this.mesh.add(handR);
        const handL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), skinMat);
        handL.position.set(-0.05, -0.1, -0.12); this.mesh.add(handL);

        // Positioning relative to Camera
        this.mesh.position.set(0.25, -0.3, -0.5);
        this.mesh.rotation.y = -0.05;
        this.mesh.visible = false;
        this.game.renderer.camera.add(this.mesh);
    }

    createShurikenModel(scale = 1) {
        const group = new THREE.Group();
        const bladeMat = new THREE.MeshStandardMaterial({
            color: 0xb8c2cc,
            roughness: 0.24,
            metalness: 0.9,
            side: THREE.DoubleSide
        });
        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x2b3036,
            roughness: 0.38,
            metalness: 0.85
        });

        const shape = new THREE.Shape();
        const points = 16;
        for (let i = 0; i <= points; i++) {
            const angle = (i / points) * Math.PI * 2 + Math.PI / 8;
            const radius = i % 2 === 0 ? 1.0 : 0.34;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            if (i === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
        }

        const blade = new THREE.Mesh(new THREE.ShapeGeometry(shape), bladeMat);
        blade.scale.setScalar(scale);
        blade.castShadow = true;
        blade.receiveShadow = true;
        group.add(blade);

        const ring = new THREE.Mesh(new THREE.TorusGeometry(scale * 0.24, scale * 0.035, 8, 24), darkMat);
        ring.position.z = 0.012;
        ring.castShadow = true;
        group.add(ring);

        const hub = new THREE.Mesh(new THREE.CylinderGeometry(scale * 0.08, scale * 0.08, scale * 0.035, 18), darkMat);
        hub.rotation.x = Math.PI / 2;
        hub.position.z = 0.018;
        group.add(hub);

        return group;
    }

    update(deltaTime) {
        if (!this.mesh) return;

        // Sniper must ALWAYS be hidden when scoped, regardless of animation state
        if (this.type === 'sniper' && this.game.player?.isAiming) {
            this.mesh.visible = false;
            this.switchAnim = 'none';
            this.switchAnimProgress = 0;
            return;
        }

        // Handle switch animation
        if (this.switchAnim === 'putting_away') {
            this.switchAnimProgress += deltaTime * 10; // Speed of drop
            const t = Math.min(this.switchAnimProgress, 1);
            // Ease-in: accelerate downward
            const eased = t * t;
            this.mesh.position.y = this.restPosition.y - eased * 0.6;
            this.mesh.rotation.x = -eased * 0.3;
            if (t >= 1) {
                this.switchAnim = 'done_putting_away';
                this.mesh.visible = false;
            }
            return;
        }

        if (this.switchAnim === 'pulling_out') {
            this.switchAnimProgress += deltaTime * 8; // Speed of rise
            const t = Math.min(this.switchAnimProgress, 1);
            // Ease-out: decelerate as it arrives
            const eased = 1 - Math.pow(1 - t, 3);
            this.mesh.position.y = (this.restPosition.y - 0.6) + eased * 0.6;
            this.mesh.rotation.x = -0.3 * (1 - eased);
            this.mesh.position.x = this.restPosition.x;
            this.mesh.position.z = this.restPosition.z;
            if (t >= 1) {
                this.switchAnim = 'none';
                this.mesh.position.set(this.restPosition.x, this.restPosition.y, this.restPosition.z);
                this.mesh.rotation.x = 0;
            }
            return;
        }

        if (this.mesh.visible) {
            const player = this.game.player;
            if (this.type === 'melee' && this.meleeSwing > 0) {
                this.meleeSwing = Math.max(0, this.meleeSwing - deltaTime * 5.5);
                const swing = Math.sin((1 - this.meleeSwing) * Math.PI);
                this.mesh.position.x = this.restPosition.x - swing * 0.22;
                this.mesh.position.y = this.restPosition.y + swing * 0.1;
                this.mesh.position.z = this.restPosition.z + swing * 0.55;
                this.mesh.rotation.x = -swing * 0.75;
                this.mesh.rotation.y = -0.05 - swing * 0.35;
                this.mesh.rotation.z = swing * 0.25;
                if (this.shurikenVisual) this.shurikenVisual.rotation.z -= deltaTime * 24;
            } else if (player.isAiming) {
                // ADS position: x=0.05 shifts gun right to align scope with crosshair
                this.mesh.position.x += (0.05 - this.mesh.position.x) * 0.2;
                this.mesh.position.y += (-0.15 - this.mesh.position.y) * 0.2;
            } else {
                this.mesh.position.x += (this.restPosition.x - this.mesh.position.x) * 0.1;
                this.mesh.position.y += (this.restPosition.y - this.mesh.position.y) * 0.1;
                this.mesh.rotation.x += (0 - this.mesh.rotation.x) * 0.15;
                this.mesh.rotation.y += (-0.05 - this.mesh.rotation.y) * 0.15;
                this.mesh.rotation.z += (0 - this.mesh.rotation.z) * 0.15;
            }
            // Recover recoil (Z-axis)
            this.mesh.position.z += (this.restPosition.z - this.mesh.position.z) * 0.1;

            if (this.muzzleFlash && this.muzzleFlash.material.opacity > 0) {
                this.muzzleFlash.material.opacity = Math.max(0, this.muzzleFlash.material.opacity - deltaTime * 20);
            }
            if (this.muzzleLight && this.muzzleLight.intensity > 0) {
                this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - deltaTime * 65);
            }
        }
    }

    tryShoot() {
        if (this.isReloading) return false;
        if (this.switchAnim !== 'none') return false; // Can't shoot during switch animation
        // Melee has infinite uses - no ammo needed
        if (this.type !== 'melee' && this.currentAmmo <= 0) { this.game.player.reload(); return false; }

        const now = performance.now();
        if (now - this.lastFireTime < 1000 / this.fireRate) return false;

        this.lastFireTime = now;
        if (this.type !== 'melee') this.currentAmmo--;
        this.fire();
        this.game.player.updateAmmoUI();
        return true;
    }

    fire() {
        const player = this.game.player;
        const renderer = this.game.renderer;
        const camera = renderer.camera;

        if (!camera || !player) {
            console.warn('[FIRE] Missing camera or player');
            return;
        }

        debugLog(`[FIRE] ${player.name} fired ${this.name} | Ammo: ${this.currentAmmo}/${this.reserveAmmo}`);

        const soundMap = { 'assault_rifle': 'shoot', 'shotgun': 'shotgun', 'sniper': 'sniper', 'rpg': 'explosion', 'melee': 'melee' };
        this.game.audioManager.playSound(soundMap[this.type] || 'shoot');

        if (this.muzzleFlash) this.muzzleFlash.material.opacity = 1;
        if (this.muzzleLight) this.muzzleLight.intensity = this.type === 'rpg' ? 8 : 3.5;
        renderer.createMuzzleBurst(camera.position.clone(), player.getAimDirection(), this.type);

        // Dynamic Recoil & Shake
        let kickRate = this.type === 'sniper' ? 0.08 : (this.type === 'rpg' ? 0.15 : (this.type === 'melee' ? 0.01 : 0.03));

        // Crouch reduces recoil
        if (player.isCrouching) kickRate *= 0.6;

        player.rotation.x += kickRate;
        renderer.shake(kickRate * 2.5, 0.1);

        // Network Fire
        if (this.game.networkManager && this.game.networkManager.connected) {
            this.game.networkManager.socket.emit('playerShoot');
        }

        if (this.type === 'melee') {
            const origin = camera.position.clone();
            const direction = player.getAimDirection();
            const hit = this.performMeleeAttack(origin, direction);
            this.meleeSwing = 1;
            this.game.renderer?.createThrownShuriken(origin, direction, hit?.point, this.range);
        } else if (this.type === 'rpg') {
            const rocket = new Projectile(this.game, 'rpg_rocket', camera.position.clone(), player.getAimDirection(), this.damage);
            this.game.projectiles.push(rocket);
        } else {
            for (let i = 0; i < this.pellets; i++) {
                this.shootRay(camera.position.clone(), player.getAimDirection());
            }
        }
        if (this.type !== 'melee') this.mesh.position.z += 0.15; // Visual kickback (skip for melee, handled above)

        // AWP-style: Unscope after shot, then auto-rescope
        if (this.type === 'sniper' && player.isAiming) {
            // Track if this was the last bullet (will need to rescope after reload)
            const wasLastBullet = this.currentAmmo <= 0;

            player.stopAiming();

            if (wasLastBullet) {
                // Set flag so reload will rescope after
                this.rescopeAfterReload = true;
            } else {
                // Auto-rescope after bolt action delay
                this.rescopeTimer = setTimeout(() => {
                    // Only rescope if still using sniper and not reloading
                    const currentWeapon = player.weapons[player.currentWeaponIndex];
                    if (currentWeapon?.type === 'sniper' && !player.isReloading) {
                        player.startAiming();
                    }
                    this.rescopeTimer = null;
                }, 500); // 500ms bolt action delay
            }
        }
    }

    performMeleeAttack(origin, direction) {
        try {
            const forward = direction.clone().normalize();
            const hit = this.game.physics.raycast(origin, forward, this.range);
            if (hit) {
                this.handleHit(hit);
                return hit;
            }
            return null;
        } catch (e) {
            debugWarn('Melee attack error:', e.message);
            return null;
        }
    }

    shootRay(origin, direction) {
        try {
            let spreadAmt = this.spread;
            const player = this.game.player;

            // 1. Aiming reduces spread siginificantly
            if (player.isAiming) spreadAmt *= 0.2;

            // 2. Crouching reduces spread (user request)
            if (player.isCrouching) spreadAmt *= 0.5;

            // 3. Moving increases spread
            const isMoving = player.velocity.x !== 0 || player.velocity.z !== 0;
            if (isMoving) spreadAmt *= 1.5;

            // 4. Air increases spread
            if (!player.isGrounded) spreadAmt *= 2.5;

            direction.x += (Math.random() - 0.5) * spreadAmt;
            direction.y += (Math.random() - 0.5) * spreadAmt;
            direction.z += (Math.random() - 0.5) * spreadAmt;
            direction.normalize();

            // HITSCAN: Instant raycast detection
            const hit = this.game.physics.raycast(origin, direction, this.range);

            if (this.game.settings.showTracers) this.drawHitscanLine(origin, direction, hit, this.range);

            if (hit) this.handleHit(hit);
        } catch (e) {
            debugWarn('ShootRay error:', e.message);
        }
    }

    drawHitscanLine(origin, direction, hit, range) {
        try {
            const scene = this.game.renderer?.scene;
            if (!scene) return;

            const endPoint = hit
                ? hit.point.clone()
                : origin.clone().add(direction.clone().multiplyScalar(range));

            // Create temporary line geometry for visual feedback
            const geometry = new THREE.BufferGeometry();
            const positions = new Float32Array([
                origin.x, origin.y, origin.z,
                endPoint.x, endPoint.y, endPoint.z
            ]);
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

            // Color based on hit or miss
            const lineColor = hit ? 0xff0000 : 0xffff00; // Red for hit, yellow for miss
            const material = new THREE.LineBasicMaterial({ color: lineColor, linewidth: 2 });
            const line = new THREE.Line(geometry, material);
            scene.add(line);

            // Remove line after short delay (visual feedback only)
            setTimeout(() => {
                geometry.dispose();
                material.dispose();
                scene.remove(line);
            }, 50);
        } catch (e) {
            debugWarn('Hitscan line error:', e.message);
        }
    }

    handleHit(hit) {
        try {
            if (!hit || !hit.object) return;
            const object = hit.object;

            // Robust traversal to find target entity root
            let target = object;
            let depth = 0;
            let targetEntity = null;
            let targetType = null;

            while (target && depth < 5) {
                if (target.userData?.type === 'remotePlayer' || target.userData?.id) {
                    targetType = 'player';
                    targetEntity = target;
                    break;
                }
                if (target.userData?.enemy || target.userData?.isEnemy) {
                    targetType = 'enemy';
                    targetEntity = target.userData.enemy || target;
                    break;
                }
                target = target.parent;
                depth++;
            }

            if (targetType === 'player' && targetEntity) {
                const targetId = targetEntity.userData?.id;
                if (!targetId) return;

                // Use isHeadshot flag from raycast result
                const isHead = hit.isHeadshot === true;
                const damage = isHead ? this.damage * 2 : this.damage;

                // Visual Juice
                if (hit.point) this.game.renderer?.createBloodEffect(hit.point);
                this.game.renderer?.shake(0.04, 0.1);

                // Log to console for debugging
                debugLog(`[RAYCAST] HIT PLAYER: ${targetId} | Headshot: ${isHead} | Damage: ${damage}`);

                if (this.game.networkManager?.connected && this.game.networkManager?.socket) {
                    debugLog(`[CLIENT] EMITTING HIT -> Target: ${targetId} Damage: ${damage}`);
                    this.game.networkManager.socket.emit('playerHit', {
                        targetId: targetId,
                        damage: damage,
                        isHeadshot: isHead
                    });
                }

                if (!this.game.networkManager?.connected) {
                    this.game.uiManager?.showHitMarker(isHead);
                    this.game.audioManager?.playSound('hit');
                }
                return;
            }

            if (targetType === 'enemy') {
                const enemy = targetEntity.userData?.enemy || targetEntity;
                if (enemy && !enemy.isDead) {
                    const isHeadshot = object.userData?.isHead === true;

                    // Log to console for debugging
                    debugLog(`[RAYCAST] HIT ENEMY: ${enemy.type} | Headshot: ${isHeadshot}`);

                    enemy.takeDamage(isHeadshot ? this.damage * 2 : this.damage, isHeadshot);
                    this.game.uiManager?.showHitMarker(isHeadshot);
                    this.game.audioManager?.playSound('hit');
                    return;
                }
            }

            // Environmental objects
            if (object.userData?.isDestructible) {
                this.game.levelManager?.damageDestructible(object, this.damage);
            } else if (hit.point && hit.face) {
                this.game.renderer?.createImpact(hit.point, hit.face.normal);
            }
        } catch (e) {
            debugWarn('HandleHit error:', e.message);
        }
    }

    reload() {
        if (this.type === 'melee') return false; // Melee never reloads
        if (this.isReloading || this.currentAmmo === this.magSize || this.reserveAmmo <= 0) return false;
        this.isReloading = true;
        this.reloadTimeout = setTimeout(() => {
            const needed = this.magSize - this.currentAmmo;
            const available = Math.min(needed, this.reserveAmmo);
            this.currentAmmo += available;
            this.reserveAmmo -= available;
            this.isReloading = false;
            this.reloadTimeout = null;
        }, this.reloadTime);
        return true;
    }

    cancelReload() {
        if (this.reloadTimeout) {
            clearTimeout(this.reloadTimeout);
            this.reloadTimeout = null;
        }
        if (this.rescopeTimer) {
            clearTimeout(this.rescopeTimer);
            this.rescopeTimer = null;
        }
        this.isReloading = false;
        this.rescopeAfterReload = false;
    }

    reset() {
        this.currentAmmo = this.magSize;
        this.reserveAmmo = this.maxReserve;
        this.isReloading = false;
        this.lastFireTime = 0;
    }

    show() {
        if (this.mesh) {
            this.mesh.visible = true;
            this.switchAnim = 'pulling_out';
            this.switchAnimProgress = 0;
            // Start below view
            this.mesh.position.y = this.restPosition.y - 0.6;
            this.mesh.rotation.x = -0.3;
        }
    }
    hide() {
        if (this.mesh) {
            // If already animating put-away or hidden, just force hide
            this.mesh.visible = false;
            this.switchAnim = 'none';
            this.switchAnimProgress = 0;
        }
    }
    animatePutAway() {
        if (this.mesh && this.mesh.visible) {
            this.switchAnim = 'putting_away';
            this.switchAnimProgress = 0;
        }
    }
}

// ==================== PROJECTILE ====================
class Projectile {
    constructor(game, type, position, direction, damage) {
        this.game = game;
        this.type = type;
        this.position = position.clone();
        this.direction = direction.clone().normalize();
        this.damage = damage;
        this.speed = 40;
        this.alive = true;
        this.radius = 0.2;
        this.lifeTime = 5;
        this.startTime = Date.now();
        this.init();
    }

    init() {
        const geometry = new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8);
        const material = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8 });
        this.mesh = new THREE.Group();

        const body = new THREE.Mesh(geometry, material);
        body.rotation.x = Math.PI / 2;
        this.mesh.add(body);

        // Rocket tip
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.15, 8), new THREE.MeshStandardMaterial({ color: 0xff4400 }));
        tip.rotation.x = Math.PI / 2;
        tip.position.z = -0.25;
        this.mesh.add(tip);

        this.mesh.position.copy(this.position);
        this.mesh.lookAt(this.position.clone().add(this.direction));
        this.game.renderer?.addToScene(this.mesh);

        this.light = new THREE.PointLight(0xffaa00, 2.2, 8, 2);
        this.mesh.add(this.light);
    }

    update(deltaTime) {
        if (!this.alive) return;
        const moveDist = this.speed * deltaTime;
        const nextPos = this.position.clone().add(this.direction.clone().multiplyScalar(moveDist));
        if (Date.now() - this.startTime > this.lifeTime * 1000) {
            this.destroy();
            return;
        }
        const hit = this.game.physics.raycast(this.position, this.direction, moveDist);
        if (hit) {
            this.position.copy(hit.point);
            this.explode();
            return;
        }
        this.position.copy(nextPos);
        this.mesh.position.copy(this.position);

        if (this.game.renderer && Math.random() < (this.game.renderer.lowFxMode ? 0.2 : 0.4)) {
            const trailPos = this.position.clone().add(this.direction.clone().multiplyScalar(-0.35));
            this.game.renderer.createSpriteParticle(trailPos, this.direction.clone().multiplyScalar(-0.7), {
                color: Math.random() > 0.45 ? 0xff8a34 : 0x6b625a,
                opacity: 0.45,
                size: 0.45 + Math.random() * 0.35,
                lifetime: 0.35 + Math.random() * 0.25,
                grow: 1.8
            });
        }
    }

    explode() {
        if (!this.alive) return;
        this.alive = false;
        this.game.renderer?.createExplosionEffect(this.position);
        this.game.audioManager?.playSound('explosion');
        this.applyExplosionDamage();
        this.destroy();
    }

    applyExplosionDamage() {
        const radius = 8;
        const players = this.game.networkManager?.remotePlayers || {};
        const myId = this.game.networkManager?.playerId;

        // Damage all players in radius (including self)
        const allPlayerIds = [...Object.keys(players)];
        if (myId) allPlayerIds.push(myId);

        allPlayerIds.forEach(id => {
            const target = (id === myId) ? this.game.player : players[id];
            const targetPos = (id === myId) ? target.position : (target.mesh?.position);

            if (targetPos) {
                const dist = this.position.distanceTo(targetPos);
                if (dist < radius) {
                    const falloff = 1 - (dist / radius);
                    const damage = Math.round(this.damage * falloff);

                    if (this.game.networkManager?.socket) {
                        this.game.networkManager.socket.emit('playerHit', {
                            targetId: id,
                            damage: damage
                        });
                    }
                }
            }
        });

        // Damage AI enemies in radius
        if (this.game.enemyManager) {
            this.game.enemyManager.enemies.forEach(enemy => {
                if (!enemy.isDead && enemy.mesh) {
                    const dist = this.position.distanceTo(enemy.mesh.position);
                    if (dist < radius) {
                        const falloff = 1 - (dist / radius);
                        const damage = Math.round(this.damage * falloff);
                        enemy.takeDamage(damage);

                        // Give player some feedback
                        if (damage > 10) {
                            this.game.uiManager?.showHitMarker(false);
                        }
                    }
                }
            });
        }
    }

    destroy() {
        this.alive = false;
        if (this.mesh) this.game.renderer?.removeFromScene(this.mesh);
        this.mesh = null;
    }
}

// ==================== LOOT DROP ====================
class LootDrop {
    constructor(game, id, x, y, z) {
        this.game = game;
        this.id = id;
        this.position = new THREE.Vector3(x, y, z);
        this.mesh = this.createMesh();
        this.game.renderer.addToScene(this.mesh);
        this.bobTime = Math.random() * Math.PI * 2;
    }

    createMesh() {
        const group = new THREE.Group();
        group.position.copy(this.position);

        // Poop geometry: Stacked toruses/cylinders
        const brown = 0x8B4513;
        const mat = new THREE.MeshStandardMaterial({ color: brown, roughness: 0.8 });

        // Base
        const c1 = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.2, 12), mat);
        c1.position.y = 0.1;
        group.add(c1);

        // Mid
        const c2 = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.2, 12), mat);
        c2.position.y = 0.3;
        group.add(c2);

        // Top swirly part
        const c3 = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.2, 12), mat);
        c3.position.y = 0.5;
        group.add(c3);

        // Fly particles
        this.flies = [];
        for (let i = 0; i < 4; i++) {
            const fly = new THREE.Mesh(
                new THREE.BoxGeometry(0.04, 0.04, 0.04),
                new THREE.MeshBasicMaterial({ color: 0x000000 })
            );
            fly.userData.angle = Math.random() * Math.PI * 2;
            fly.userData.radius = 0.3 + Math.random() * 0.3;
            fly.userData.speed = 3 + Math.random() * 4;
            fly.userData.yOffset = Math.random() * Math.PI * 2;
            group.add(fly);
            this.flies.push(fly);
        }

        return group;
    }

    update(deltaTime) {
        if (!this.mesh) return;

        // Hovering/Bobbing
        this.bobTime += deltaTime * 3;
        this.mesh.position.y = this.position.y + Math.sin(this.bobTime) * 0.15;
        this.mesh.rotation.y += deltaTime * 2;

        // Flies buzzing
        this.flies.forEach(fly => {
            fly.userData.angle += deltaTime * fly.userData.speed;
            fly.position.x = Math.cos(fly.userData.angle) * fly.userData.radius;
            fly.position.z = Math.sin(fly.userData.angle) * fly.userData.radius;
            fly.position.y = 0.4 + Math.sin(fly.userData.angle * 2 + fly.userData.yOffset) * 0.2;
        });
    }

    destroy() {
        if (this.mesh) {
            this.game.renderer.removeFromScene(this.mesh);
            this.mesh.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
        }
        this.mesh = null;
    }
}

// ==================== ENEMY ====================
class Enemy {
    constructor(game, type, x, z) {
        this.game = game;
        this.type = type;
        this.position = new THREE.Vector3(x, 0, z);
        this.rotation = new THREE.Euler(0, Math.random() * Math.PI * 2, 0);
        this.setupStats();
        this.state = 'patrol';
        this.stateTime = 0;
        this.patrolPoints = this.generatePatrolPoints();
        this.currentPatrolIndex = 0;
        this.patrolWaitTime = 0;
        this.lastAttackTime = 0;
        this.lastSeenPlayer = null;
        this.lastSeenTime = 0;
        this.detectionRange = 40;
        this.attackRange = this.type === 'sniper' ? 50 : 25;
        this.mesh = null;
        this.createMesh();
    }

    setupStats() {
        const stats = {
            soldier: { maxHealth: 50, speed: 4, damage: 10, attackRate: 2, color: 0x884444 },
            heavy: { maxHealth: 150, speed: 2, damage: 20, attackRate: 1, color: 0x664422 },
            sniper: { maxHealth: 30, speed: 3, damage: 40, attackRate: 0.5, color: 0x446644 }
        };
        const s = stats[this.type] || stats.soldier;
        Object.assign(this, s);
        this.health = this.maxHealth;
        this.isDead = false;
    }

    createMesh() {
        this.mesh = new THREE.Group();

        const bodyMat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.7 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.3, 0.4), bodyMat);
        body.position.y = 0.9;
        body.castShadow = true;
        this.mesh.add(body);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), new THREE.MeshStandardMaterial({ color: 0xddaa88 }));
        head.position.y = 1.85;
        head.castShadow = true;
        head.userData = { isHead: true }; // Explicit head data for AI
        this.mesh.add(head);

        this.mesh.position.copy(this.position);
        this.mesh.userData.enemy = this;
        this.mesh.userData.isEnemy = true;
        this.mesh.userData.isMoving = true;

        // Health Bar for AI
        const healthBg = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.1), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        healthBg.position.y = 2.2;
        this.mesh.add(healthBg);

        this.healthFill = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.1), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
        this.healthFill.position.z = 0.01;
        healthBg.add(this.healthFill);

        this.game.renderer.addToScene(this.mesh);
        this.game.physics.addCollider(this.mesh, 'enemy');
    }

    generatePatrolPoints() {
        const points = [];
        const radius = 15 + Math.random() * 10;
        for (let i = 0; i < 3; i++) {
            const angle = (i / 3) * Math.PI * 2;
            points.push(new THREE.Vector3(this.position.x + Math.cos(angle) * radius, 0, this.position.z + Math.sin(angle) * radius));
        }
        return points;
    }

    update(deltaTime) {
        if (this.isDead) return;
        this.stateTime += deltaTime;

        const player = this.game.player;
        const toPlayer = player.position.clone().sub(this.position);
        const distance = toPlayer.length();
        const canSee = distance < this.detectionRange;

        if (canSee) {
            this.lastSeenPlayer = player.position.clone();
            this.lastSeenTime = performance.now();
        }

        if (this.state === 'patrol') {
            if (canSee) { this.state = 'chase'; return; }
            if (this.patrolWaitTime > 0) { this.patrolWaitTime -= deltaTime; return; }
            const target = this.patrolPoints[this.currentPatrolIndex];
            if (target.distanceTo(this.position) < 1) {
                this.currentPatrolIndex = (this.currentPatrolIndex + 1) % this.patrolPoints.length;
                this.patrolWaitTime = 2;
            } else {
                this.moveTowards(target, this.speed * 0.5, deltaTime);
            }
        } else if (this.state === 'chase') {
            if (distance < this.attackRange && canSee) { this.state = 'attack'; return; }
            if (!canSee && performance.now() - this.lastSeenTime > 5000) { this.state = 'patrol'; return; }
            this.moveTowards(canSee ? player.position : this.lastSeenPlayer, this.speed, deltaTime);
        } else if (this.state === 'attack') {
            this.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
            if (distance > this.attackRange * 1.2 || !canSee) { this.state = 'chase'; return; }

            const now = performance.now();
            if (now - this.lastAttackTime > 1000 / this.attackRate) {
                this.attack(player);
                this.lastAttackTime = now;
            }
        }

        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.rotation.y;
    }

    moveTowards(target, speed, deltaTime) {
        const toTarget = target.clone().sub(this.position);
        toTarget.y = 0;
        if (toTarget.length() > 0.1) {
            this.rotation.y = Math.atan2(toTarget.x, toTarget.z);
            toTarget.normalize();
            const newPos = this.position.clone().add(toTarget.multiplyScalar(speed * deltaTime));
            if (this.game.physics.checkMovement(this.position, newPos, 0.4)) {
                this.position.copy(newPos);
            }
        }
    }

    attack(player) {
        this.game.audioManager.play3DSound('enemyShoot', this.position, player.position);
        const distance = player.position.distanceTo(this.position);
        let accuracy = this.type === 'sniper' ? 0.9 : (this.type === 'heavy' ? 0.5 : 0.7);
        accuracy *= Math.max(0.3, 1 - distance / 50);
        if (Math.random() < accuracy) player.takeDamage(this.damage);
    }

    takeDamage(amount) {
        if (this.isDead) return;
        this.health -= amount;

        if (this.healthFill) {
            const pct = Math.max(0, this.health / this.maxHealth);
            this.healthFill.scale.x = pct;
            this.healthFill.position.x = (pct - 1) * 0.4;
        }

        if (this.state === 'patrol') {
            this.state = 'chase';
            this.lastSeenPlayer = this.game.player.position.clone();
        }
        if (this.health <= 0) this.die();
    }

    die() {
        this.isDead = true;
        this.game.physics.removeCollider(this.mesh);
        this.game.addKill(this.type);
        this.game.uiManager.updateEnemyCount(this.game.enemyManager.getRemainingEnemies());

        const fall = () => {
            this.mesh.rotation.x += 0.1;
            this.mesh.position.y -= 0.05;
            if (this.mesh.rotation.x < Math.PI / 2) requestAnimationFrame(fall);
        };
        fall();
        setTimeout(() => this.game.renderer.removeFromScene(this.mesh), 3000);
    }
}

// ==================== PLAYER ====================
class Player {
    constructor(game) {
        this.game = game;
        this.position = new THREE.Vector3(0, 1.7, 30);
        this.rotation = new THREE.Euler(0, 0, 0, 'YXZ');
        this.velocity = new THREE.Vector3();
        this.maxHealth = 100;
        this.health = 100;
        this.isDead = false;
        this.walkSpeed = 8;
        this.sprintSpeed = 14;
        this.jumpForce = 12;
        this.isGrounded = true;
        this.isSprinting = false;
        this.eyeHeight = 1.7;
        this.bobAmount = 0;
        this.weapons = [];
        this.currentWeaponIndex = 0;
        this.isAiming = false;
        this.isShooting = false;
        this.isReloading = false;
        this.init();
        this.moveDir = new THREE.Vector3();
        this.yAxis = new THREE.Vector3(0, 1, 0);
    }

    init() {
        this.game.renderer.camera.position.copy(this.position);

        this.weapons = [
            new Weapon(this.game, 'assault_rifle', { name: 'ASSAULT RIFLE', damage: 25, fireRate: 10, magSize: 30, reserveAmmo: 90, reloadTime: 2000, spread: 0.02, range: 100, automatic: true }),
            new Weapon(this.game, 'pistol', { name: 'PISTOL', damage: 20, fireRate: 4, magSize: 12, reserveAmmo: 48, reloadTime: 1200, spread: 0.015, range: 50, automatic: false }),
            new Weapon(this.game, 'melee', { name: 'SHURIKEN', damage: 55, fireRate: 2.5, magSize: 1, reserveAmmo: 0, reloadTime: 0, spread: 0, range: 4, automatic: false }),
            new Weapon(this.game, 'shotgun', { name: 'SHOTGUN', damage: 15, fireRate: 1.5, magSize: 8, reserveAmmo: 32, reloadTime: 2500, spread: 0.1, range: 30, automatic: false, pellets: 8 }),
            new Weapon(this.game, 'smg', { name: 'SUBMACHINE GUN', damage: 15, fireRate: 15, magSize: 40, reserveAmmo: 120, reloadTime: 1500, spread: 0.04, range: 60, automatic: true }),
            new Weapon(this.game, 'sniper', { name: 'SNIPER RIFLE', damage: 100, fireRate: 0.8, magSize: 5, reserveAmmo: 20, reloadTime: 3000, spread: 0.001, range: 200, automatic: false }),
            new Weapon(this.game, 'rpg', { name: 'RPG-7', damage: 150, fireRate: 0.5, magSize: 1, reserveAmmo: 5, reloadTime: 3000, spread: 0.01, range: 150, automatic: false })
        ];

        this.weapons.forEach(w => w.createModel());
        this.equipWeapon(0);
    }

    reset() {
        this.position.set(0, 1.7, 30);
        this.rotation.set(0, 0, 0);
        this.velocity.set(0, 0, 0);
        this.health = this.maxHealth;
        this.isDead = false;
        this.isAiming = false;
        this.isShooting = false;
        this.isReloading = false;
        this.weapons.forEach(w => w.reset());
        this.equipWeapon(0);
        this.restoreAmmo();
        this.game.uiManager.updateHealth(this.health, this.maxHealth);
        this.updateAmmoUI();
    }

    restoreAmmo() {
        this.weapons.forEach(weapon => {
            weapon.currentAmmo = weapon.magSize;
            weapon.reserveAmmo = weapon.maxReserve;
            weapon.isReloading = false;
        });
        this.updateAmmoUI();
    }

    update(deltaTime) {
        if (this.isDead) return;
        this.handleMovement(deltaTime);
        if (this.isShooting && !this.isReloading) this.weapons[this.currentWeaponIndex]?.tryShoot();
        this.updateCamera();
        this.weapons[this.currentWeaponIndex]?.update(deltaTime);
    }

    handleMovement(deltaTime) {
        const input = this.game.inputManager.keys;
        const moveDir = this.moveDir.set(0, 0, 0);

        // 1. Crouch Logic
        const wasCrouching = this.isCrouching;
        this.isCrouching = input.crouch; // Hold to crouch

        // Smooth Camera Height Transition
        const targetHeight = this.isCrouching ? 1.0 : 1.7;
        this.eyeHeight += (targetHeight - this.eyeHeight) * 10 * deltaTime;

        // 2. Input Handling
        if (input.forward) moveDir.z -= 1;
        if (input.backward) moveDir.z += 1;
        if (input.left) moveDir.x -= 1;
        if (input.right) moveDir.x += 1;

        if (moveDir.length() > 0) moveDir.normalize();
        moveDir.applyAxisAngle(this.yAxis, this.rotation.y);

        // 3. Speed Calculation
        this.isSprinting = input.sprint && moveDir.z < 0 && !this.isAiming && !this.isCrouching;

        let speed = this.walkSpeed;
        if (this.isSprinting) speed = this.sprintSpeed;
        if (this.isCrouching) speed = this.walkSpeed * 0.5; // Slower when crouching
        if (this.isAiming) speed *= 0.6; // Slower when aiming
        if (this.weapons[this.currentWeaponIndex]?.type === 'melee') speed *= 1.2; // Faster with melee

        // Set horizontal velocity (m/s)
        this.velocity.x = moveDir.x * speed;
        this.velocity.z = moveDir.z * speed;

        // 4. Handle Jumping
        if (input.jump && this.isGrounded && !this.isCrouching) {
            this.velocity.y = this.jumpForce;
            this.isGrounded = false;
        }

        // Apply Gravity
        if (!this.isGrounded) {
            this.velocity.y += this.game.physics.gravity * deltaTime;
        }

        // Calculate theoretical displacement for this frame
        const deltaMove = this.velocity.clone().multiplyScalar(deltaTime);
        if (deltaMove.lengthSq() < 0.000001 && this.isGrounded) {
            return;
        }

        // Resolve Collisions (Pass current player height for capsule check)
        // Standing = 1.8m, Crouching = 1.2m
        const colliderHeight = this.isCrouching ? 1.2 : 1.8;
        const result = this.game.physics.resolveCollision(this.position, deltaMove, 0.4, colliderHeight);

        this.position.x = result.position.x;
        this.position.z = result.position.z;
        this.position.y = result.position.y;

        // If Y velocity was cut to zero by physics, it means we hit a ceiling or ground
        if (result.velocity.y === 0 && deltaMove.y !== 0) {
            if (this.velocity.y < 0) this.isGrounded = true; // Landed on something
            this.velocity.y = 0;
        } else {
            // Check if we walked off an edge
            if (this.isGrounded && result.velocity.y !== 0) {
                this.isGrounded = false;
            }
        }

        // Hard Ground Floor (Safety Net)
        // Camera/Eye position is decoupled from physics position in some engines, 
        // but here position IS the camera/body pivot.
        // We usually track "Feet" position for physics, but this engine seems to track "Eye" position?
        // Wait, line 1209 says: "if (this.position.y <= this.eyeHeight) ... this.position.y = this.eyeHeight"
        // This implies position.y IS eye height relative to world 0? 
        // If world floor is 0, and eye is 1.7, then position.y should be >= 1.7.
        // But previously I implemented `resolveCollision` assuming `position` is... generic.
        // Let's stick to the existing convention: position is CAMERA/HEAD level.

        if (this.position.y < this.eyeHeight && this.velocity.y <= 0) {
            // Basic floor clamp if physics failed or we are in void
            // Actually, rely on physics `resolveCollision` hitting ground (y=0 or mesh).
            // If physics didn't catch it (void), clamp to floor 0 + eyeHeight
            if (this.position.y < this.eyeHeight) {
                this.position.y = this.eyeHeight;
                this.velocity.y = 0;
                this.isGrounded = true;
            }
        }

        // Map Bounds
        this.position.x = Math.max(-95, Math.min(95, this.position.x));
        this.position.z = Math.max(-95, Math.min(95, this.position.z));

        if (this.isGrounded && moveDir.length() > 0) {
            this.bobAmount += deltaTime * 10 * (this.isSprinting ? 1.5 : 1);
        }
    }

    look(dx, dy) {
        this.rotation.y -= dx;
        this.rotation.x -= dy;
        this.rotation.x = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.rotation.x));
    }

    updateCamera() {
        const camera = this.game.renderer.camera;
        camera.position.copy(this.position);
        if (this.isGrounded && !this.isAiming) {
            camera.position.y += Math.sin(this.bobAmount) * 0.05;
        }
        camera.rotation.copy(this.rotation);
        const targetFov = this.isAiming ? 45 : 75;
        camera.fov += (targetFov - camera.fov) * 0.2;
        camera.updateProjectionMatrix();
    }

    startShooting() { this.isShooting = true; }
    stopShooting() { this.isShooting = false; }
    startAiming() {
        this.isAiming = true;
        this.game.uiManager.setAiming(true);
        // Show sniper scope if using sniper
        if (this.weapons[this.currentWeaponIndex]?.type === 'sniper') {
            document.getElementById('sniper-scope')?.classList.remove('hidden');
            document.getElementById('crosshair')?.classList.add('hidden');
            // Hide the weapon model when scoped
            this.weapons[this.currentWeaponIndex].mesh.visible = false;
        }
    }
    stopAiming() {
        this.isAiming = false;
        this.game.uiManager.setAiming(false);
        // Hide sniper scope
        document.getElementById('sniper-scope')?.classList.add('hidden');
        document.getElementById('crosshair')?.classList.remove('hidden');
        // Show the weapon model when unscoping
        if (this.weapons[this.currentWeaponIndex]?.type === 'sniper') {
            this.weapons[this.currentWeaponIndex].mesh.visible = true;
        }
    }

    reload() {
        const weapon = this.weapons[this.currentWeaponIndex];
        if (weapon && !this.isReloading && weapon.reload()) {
            // Track if player was scoped before reloading (for sniper auto-rescope)
            // Track if player was scoped before reloading, or if they fired last bullet while scoped
            const shouldRescopeAfter = (this.isAiming && weapon.type === 'sniper') || weapon.rescopeAfterReload;
            weapon.rescopeAfterReload = false; // Reset flag

            // Unscope when reloading
            if (this.isAiming) {
                this.stopAiming();
            }
            this.isReloading = true;
            this.game.uiManager.showReload(weapon.reloadTime);
            this.game.audioManager.playSound('reload');
            this.reloadTimer = setTimeout(() => {
                this.isReloading = false;
                this.reloadTimer = null;
                this.updateAmmoUI();
                // Auto-rescope after reload if was scoped before (or fired last bullet while scoped)
                const currentWeapon = this.weapons[this.currentWeaponIndex];
                if (shouldRescopeAfter && currentWeapon?.type === 'sniper') {
                    this.startAiming();
                }
            }, weapon.reloadTime);
        }
    }

    switchWeapon(index) {
        if (index < 0 || index >= this.weapons.length || index === this.currentWeaponIndex) return;

        // Cancel any in-progress switch animation
        if (this.switchTimer) {
            clearTimeout(this.switchTimer);
            this.switchTimer = null;
            // Force-hide the old weapon that was being put away
            this.weapons.forEach(w => { w.hide(); });
        }

        // Cancel reload if switching weapons mid-reload
        if (this.isReloading) {
            this.isReloading = false;
            const currentWeapon = this.weapons[this.currentWeaponIndex];
            if (currentWeapon) currentWeapon.cancelReload();
            // Clear the Player-level reload timer (prevents sniper rescope etc.)
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
                this.reloadTimer = null;
            }
            // Hide reload UI
            const reloadIndicator = document.getElementById('reload-indicator');
            if (reloadIndicator) reloadIndicator.classList.add('hidden');
        }

        // Clear any pending sniper rescope flag
        const currentWeapon = this.weapons[this.currentWeaponIndex];
        if (currentWeapon) {
            currentWeapon.rescopeAfterReload = false;
        }

        // Unscope when switching weapons
        if (this.isAiming) {
            this.stopAiming();
        }

        // Animate old weapon dropping down
        const oldWeapon = this.weapons[this.currentWeaponIndex];
        this.previousWeaponIndex = this.currentWeaponIndex;
        this.currentWeaponIndex = index;
        const newWeapon = this.weapons[this.currentWeaponIndex];
        this.isSwitchingWeapon = true;

        if (oldWeapon && oldWeapon.mesh && oldWeapon.mesh.visible) {
            oldWeapon.animatePutAway();
            // Wait for put-away animation, then show new weapon
            this.switchTimer = setTimeout(() => {
                oldWeapon.hide();
                newWeapon?.show();
                this.isSwitchingWeapon = false;
                this.switchTimer = null;
            }, 100); // Put-away takes ~100ms
        } else {
            // No old weapon visible, just show new one
            oldWeapon?.hide();
            newWeapon?.show();
            this.isSwitchingWeapon = false;
        }

        // Notify server
        if (this.game.networkManager?.connected && newWeapon) {
            this.game.networkManager.socket.emit('switchWeapon', newWeapon.type);
        }

        this.game.uiManager.updateWeaponSlot(index);
        this.updateAmmoUI();
    }

    equipWeapon(index) {
        this.currentWeaponIndex = index;
        this.weapons.forEach((w, i) => i === index ? w.show() : w.hide());
        this.game.uiManager.updateWeaponSlot(index);
        this.updateAmmoUI();
    }

    updateAmmoUI() {
        const w = this.weapons[this.currentWeaponIndex];
        if (w) {
            if (w.type === 'melee') {
                this.game.uiManager.updateAmmo('∞', '∞', w.name);
            } else {
                this.game.uiManager.updateAmmo(w.currentAmmo, w.reserveAmmo, w.name);
            }
        }
    }

    takeDamage(amount, attackerId = null) {
        if (this.isDead) return;
        this.health -= amount;
        this.game.uiManager.updateHealth(this.health, this.maxHealth);
        this.game.uiManager.showDamage();
        this.game.audioManager.playSound('playerHit');

        if (this.health <= 0) {
            this.lastAttackerId = attackerId;
            this.die();
        }
    }

    die() {
        if (this.isDead) return;
        this.isDead = true;
        this.health = 0;

        // Notify server of death
        if (this.game.networkManager && this.game.networkManager.connected) {
            this.game.networkManager.socket.emit('playerDied', this.lastAttackerId);
        }

        this.game.playerDied();
    }

    getAimDirection() {
        const dir = new THREE.Vector3();
        this.game.renderer.camera.getWorldDirection(dir);
        return dir;
    }
}

// ==================== ENEMY MANAGER ====================
class EnemyManager {
    constructor(game) {
        this.game = game;
        this.enemies = [];
        this.maxEnemies = 10;
    }

    spawnEnemies() {
        this.enemies.forEach(e => this.game.renderer.removeFromScene(e.mesh));
        this.enemies = [];

        const spawns = this.game.levelManager.getSpawnPoints();
        const types = ['soldier', 'soldier', 'soldier', 'heavy', 'sniper'];

        for (let i = 0; i < this.maxEnemies && i < spawns.length; i++) {
            this.enemies.push(new Enemy(this.game, types[i % types.length], spawns[i].x, spawns[i].z));
        }
        this.game.uiManager.updateEnemyCount(this.enemies.length);
    }

    update(deltaTime) {
        this.enemies.forEach(e => { if (!e.isDead) e.update(deltaTime); });
    }

    getRemainingEnemies() {
        return this.enemies.filter(e => !e.isDead).length;
    }
}

// ==================== LEVEL MANAGER ====================
class LevelManager {
    constructor(game) {
        this.game = game;
        this.buildings = [];
        this.spawnPoints = [];
        this.destructibles = [];
        this.textureLoader = new THREE.TextureLoader();
        this.gltfLoader = new THREE.GLTFLoader(); // Add GLTF loader for .glb files
        this.mapModel = null; // Store loaded map model
    }

    async loadLevel() {
        this.createSkybox();

        // Load the 3D map from GLB file
        await this.loadMapModel();

        return this;
    }

    async loadMapModel() {
        return new Promise((resolve, reject) => {
            this.gltfLoader.load(
                'assets/fps map low poly.glb',
                (gltf) => {
                    debugLog('[LEVEL] FPS Map loaded successfully');
                    this.mapModel = gltf.scene;

                    // Scale and position the map as needed
                    // You may need to adjust these values based on the map's actual size
                    this.mapModel.scale.set(1, 1, 1);
                    this.mapModel.position.set(0, 0, 0);
                    this.mapModel.updateMatrixWorld(true);
                    tuneObjectSurface(this.mapModel, 'world');

                    // Enable shadows and add physics colliders for each mesh
                    this.mapModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;

                            // Add each mesh as a physics collider
                            // Determine collider type based on mesh name or properties
                            const name = child.name.toLowerCase();
                            let colliderType = 'building';

                            if (name.includes('ground') || name.includes('floor') || name.includes('terrain')) {
                                colliderType = 'ground';
                            } else if (name.includes('crate') || name.includes('box')) {
                                colliderType = 'crate';
                            } else if (name.includes('vehicle') || name.includes('car')) {
                                colliderType = 'vehicle';
                            }

                            this.game.physics.addCollider(child, colliderType);
                        }
                    });

                    // Add the map to the scene
                    this.game.renderer.addToScene(this.mapModel);

                    // Create a fallback ground plane for physics (in case map doesn't have one)
                    this.createFallbackGround();

                    debugLog('[LEVEL] Map physics colliders registered');
                    resolve(gltf);
                },
                (progress) => {
                    // Loading progress
                    const pct = (progress.loaded / progress.total) * 100;
                    debugLog(`[LEVEL] Loading map: ${pct.toFixed(1)}%`);
                },
                (error) => {
                    console.error('[LEVEL] Error loading FPS map:', error);
                    debugLog('[LEVEL] Falling back to procedural level');
                    // Fallback to procedural level if map fails to load
                    this.createGround();
                    this.createWarehouseLevel();
                    resolve(null);
                }
            );
        });
    }

    createFallbackGround() {
        // Create an invisible ground plane for physics fallback
        const groundGeom = new THREE.PlaneGeometry(500, 500);
        const ground = new THREE.Mesh(groundGeom, new THREE.MeshBasicMaterial({
            visible: false
        }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        ground.receiveShadow = true;
        this.game.renderer.addToScene(ground);
        this.game.physics.addCollider(ground, 'ground');
    }

    createGround() {
        const groundGeom = new THREE.PlaneGeometry(200, 200, 20, 20);

        const texture = createIndustrialTexture('#585b55', '#343b34', '#a38255');
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(20, 20);
        texture.encoding = THREE.sRGBEncoding;

        const ground = new THREE.Mesh(groundGeom, new THREE.MeshStandardMaterial({
            map: texture,
            roughness: 0.4,
            metalness: 0.6
        }));
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.game.renderer.addToScene(ground);
        this.game.physics.addCollider(ground, 'ground');
    }

    createSkybox() {
        const skyGeom = new THREE.SphereGeometry(450, 32, 24);
        const sky = new THREE.Mesh(skyGeom, new THREE.ShaderMaterial({
            uniforms: {
                topColor: { value: new THREE.Color(0x526f91) },
                horizonColor: { value: new THREE.Color(0xb8a383) },
                bottomColor: { value: new THREE.Color(0x56524c) },
                sunPosition: { value: new THREE.Vector3(0.45, 0.6, -0.35).normalize() }
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPosition.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 horizonColor;
                uniform vec3 bottomColor;
                uniform vec3 sunPosition;
                varying vec3 vWorldPosition;
                void main() {
                    vec3 direction = normalize(vWorldPosition);
                    float height = direction.y;
                    float sun = pow(max(dot(direction, sunPosition), 0.0), 360.0);
                    vec3 sky = mix(bottomColor, horizonColor, smoothstep(-0.35, 0.25, height));
                    sky = mix(sky, topColor, smoothstep(0.05, 0.95, height));
                    sky += vec3(1.0, 0.62, 0.28) * sun * 0.85;
                    gl_FragColor = vec4(sky, 1.0);
                }
            `,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false
        }));
        sky.renderOrder = -1000;
        this.game.renderer.addToScene(sky);

        const sunTexture = createSoftParticleTexture('rgba(255, 214, 148, 1)', 'rgba(255, 140, 60, 0)');
        const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: sunTexture,
            color: 0xffd6a0,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false
        }));
        sunSprite.position.set(170, 180, -135);
        sunSprite.scale.set(85, 85, 1);
        this.game.renderer.addToScene(sunSprite);
    }

    createWarehouseLevel() {
        const wallTex = createIndustrialTexture('#686965', '#383d3b', '#5ea6b8');
        wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
        wallTex.repeat.set(1, 1);
        wallTex.encoding = THREE.sRGBEncoding;

        const mat1 = new THREE.MeshStandardMaterial({
            map: wallTex,
            color: 0xaaaaaa, // Slight tint
            roughness: 0.3,
            metalness: 0.8
        });
        const mat2 = new THREE.MeshStandardMaterial({
            map: wallTex,
            color: 0x666666, // Darker tint
            roughness: 0.3,
            metalness: 0.8
        });
        const crateMat = new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.9 });

        // Buildings
        this.createBuilding(0, 0, 0, 30, 12, 40, mat1);
        this.createBuilding(-50, 0, 20, 20, 8, 25, mat2);
        this.createBuilding(50, 0, -15, 25, 10, 30, mat2);
        this.createBuilding(-45, 0, -40, 18, 6, 20, mat1);
        this.createBuilding(55, 0, 40, 22, 9, 28, mat1);

        // Crates
        [[-10, -15, 2], [8, 12, 1.5], [-20, 5, 2.5], [15, -8, 2], [-5, 25, 1.8], [30, 20, 2.2]].forEach(([x, z, s]) => {
            const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
            crate.position.set(x, s / 2, z);
            crate.castShadow = true;
            this.game.renderer.addToScene(crate);
            this.game.physics.addCollider(crate, 'crate');
        });

        // Vehicles
        this.createVehicle('car', 15, 25, 0.5);
        this.createVehicle('car', 20, 28, 0.2);
        this.createVehicle('van', -15, -25, -0.8);
        this.createVehicle('minivan', -25, 10, 2.5);
        this.createVehicle('truck', 35, -35, 1.2);
        this.createVehicle('car', -35, 35, -2.0);
        this.createVehicle('van', 8, -45, 0);
        this.createVehicle('minivan', -5, 45, 3.14);

        // EXTRA TRAFFIC & COVER

        // North Side Parking
        this.createVehicle('van', 30, 70, 0.5);
        this.createVehicle('car', 36, 72, 0.2);
        this.createVehicle('truck', 22, 68, -0.2);

        // South Side Parking
        this.createVehicle('minivan', -30, -70, 2.5);
        this.createVehicle('car', -36, -72, -2.8);
        this.createVehicle('car', -25, -65, 3.0);

        // Flank Routes
        this.createVehicle('truck', 75, 10, 1.57); // East Wall Cover
        this.createVehicle('van', 75, -15, 1.4);
        this.createVehicle('truck', -75, -10, -1.57); // West Wall Cover
        this.createVehicle('minivan', -72, 20, -1.8);

        // Scatter
        this.createVehicle('car', 0, 85, 0);
        this.createVehicle('car', 0, -85, 3.14);
        this.createVehicle('car', 50, 50, 0.7);
        this.createVehicle('car', -50, -50, -0.7);

        // Concrete Barriers (Low Walls)
        const barrierMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9 });
        const barrierLocs = [
            [15, 15, 1.57], [-15, 15, -1.57], [15, -15, 1.57], [-15, -15, -1.57], // Central ring
            [40, 40, 0.7], [-40, -40, 0.7], [-40, 40, -0.7], [40, -40, -0.7], // Outer diagonal
            [0, 35, 0], [0, -35, 0], // Mid barriers
            [60, 0, 1.57], [-60, 0, 1.57] // Side barriers
        ];

        barrierLocs.forEach(([x, z, ry]) => {
            const barrier = new THREE.Mesh(new THREE.BoxGeometry(4, 1.2, 0.5), barrierMat);
            barrier.position.set(x, 0.6, z);
            barrier.rotation.y = ry;
            barrier.castShadow = true;
            barrier.receiveShadow = true;
            this.game.renderer.addToScene(barrier);
            this.game.physics.addCollider(barrier, 'barrier');
        });

        // Spawn points (Server authoritative now)
        this.spawnPoints = [];
    }

    createBuilding(x, y, z, w, h, d, mat) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        mesh.position.set(x, h / 2 + y, z);
        mesh.castShadow = true; mesh.receiveShadow = true;
        this.game.renderer.addToScene(mesh);
        this.game.physics.addCollider(mesh, 'building');
        this.buildings.push({ x, z, width: w, depth: d });

        // Add neon edges
        const edges = new THREE.EdgesGeometry(mesh.geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending }));
        mesh.add(line);
    }

    createVehicle(type, x, z, rot) {
        const group = new THREE.Group();

        let bodyGeom, roofGeom;
        const vehiclePalette = [0x4d5d5a, 0x6f503e, 0x2f4759, 0x8a7a5b, 0x523f3f, 0x3f4a36];
        const vehicleColor = vehiclePalette[Math.floor(Math.random() * vehiclePalette.length)];
        let bodyMat = new THREE.MeshStandardMaterial({ color: vehicleColor, roughness: 0.38, metalness: 0.45 });
        let glassMat = new THREE.MeshStandardMaterial({ color: 0x18212a, roughness: 0.08, metalness: 0.05, transparent: true, opacity: 0.72 });
        let wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.85, metalness: 0.08 });

        // Dimensions
        let bodyW, bodyH, bodyD, roofW, roofH, roofD, roofY;

        switch (type) {
            case 'car':
                bodyW = 2; bodyH = 0.7; bodyD = 4.5;
                roofW = 1.8; roofH = 0.6; roofD = 2.2; roofY = 0.65;
                break;
            case 'van':
                bodyW = 2.2; bodyH = 1.2; bodyD = 5;
                roofW = 2.1; roofH = 0.8; roofD = 3.5; roofY = 0.9;
                break;
            case 'minivan':
                bodyW = 2; bodyH = 0.8; bodyD = 4.8;
                roofW = 1.9; roofH = 0.7; roofD = 3.0; roofY = 0.75;
                break;
            case 'truck':
                bodyW = 2.4; bodyH = 1.0; bodyD = 6;
                roofW = 2.3; roofH = 1.2; roofD = 1.5; roofY = 1.0; // Cab
                // Truck bed
                const bed = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.8, 3.5), new THREE.MeshStandardMaterial({ color: 0x333333 }));
                bed.position.set(0, 0.4, 1.0);
                group.add(bed);
                roofD = 1.5; // Only cab roof
                // Offset hood/roof for truck
                break;
        }

        // Main Body
        const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyD), bodyMat);
        body.position.y = bodyH / 2 + 0.4; // Lift for wheels
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        // Roof (Cabin)
        const roof = new THREE.Mesh(new THREE.BoxGeometry(roofW, roofH, roofD), bodyMat);
        roof.position.y = bodyH + roofH / 2 + 0.4;
        if (type === 'truck') roof.position.z = -1.5;
        roof.castShadow = true;
        group.add(roof);

        // Windows (Simple black blocks slightly larger than roof)
        const windowMesh = new THREE.Mesh(new THREE.BoxGeometry(roofW + 0.05, roofH * 0.8, roofD * 0.8), glassMat);
        windowMesh.position.copy(roof.position);
        group.add(windowMesh);

        // Wheels
        const wheelGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 16);
        wheelGeom.rotateZ(Math.PI / 2);

        const wheelPos = [
            { x: bodyW / 2, z: bodyD / 2 - 0.8 },
            { x: -bodyW / 2, z: bodyD / 2 - 0.8 },
            { x: bodyW / 2, z: -bodyD / 2 + 0.8 },
            { x: -bodyW / 2, z: -bodyD / 2 + 0.8 },
        ];

        wheelPos.forEach(p => {
            const wheel = new THREE.Mesh(wheelGeom, wheelMat);
            wheel.position.set(p.x, 0.4, p.z);
            wheel.castShadow = true;
            group.add(wheel);
        });

        // Lights
        const headLightGeom = new THREE.BoxGeometry(0.4, 0.2, 0.1);
        const tailLightGeom = new THREE.BoxGeometry(0.4, 0.2, 0.1);
        const headLightMat = new THREE.MeshBasicMaterial({ color: 0xffffcc });
        const tailLightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });

        // Headlights
        [-0.6, 0.6].forEach(x => {
            const hl = new THREE.Mesh(headLightGeom, headLightMat);
            hl.position.set(x, bodyH - 0.1, -bodyD / 2 - 0.05); // Front
            body.add(hl);

            const tl = new THREE.Mesh(tailLightGeom, tailLightMat);
            tl.position.set(x, bodyH - 0.1, bodyD / 2 + 0.05); // Back
            body.add(tl);
        });

        group.position.set(x, 0, z);
        group.rotation.y = rot;

        this.game.renderer.addToScene(group);
        this.game.physics.addCollider(group, 'vehicle');
    }

    damageDestructible(obj, dmg) { }
    reset() { }
    getSpawnPoints() { return this.spawnPoints; }
}

// ==================== RENDERER ====================
class Renderer {
    constructor(game) {
        this.game = game;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.canvas = null;

        // Shake state
        this.shakeAmount = 0;
        this.shakeDuration = 0;
        this.particles = [];
        this.maxParticles = 90;
        this.lowFxMode = false;
        this.dustUpdateTimer = 0;
        this.dust = null;
        this.dustPositions = null;
        this.dustSpeeds = null;
        this.particleGeom = null;
        this.flashTexture = null;
        this.performanceMode = false;
        this.sunLight = null;
        this.throwables = [];
        this.shurikenGeometry = null;
        this.shurikenMaterial = null;
    }

    async init() {
        this.lowFxMode = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            (navigator.deviceMemory && navigator.deviceMemory <= 4);
        this.maxParticles = this.lowFxMode ? 45 : 90;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x7e8a93);
        this.scene.fog = new THREE.FogExp2(0x9a9387, 0.0065);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 1000); // Near 0.01
        this.camera.position.set(0, 2, 0);
        this.camera.rotation.order = 'YXZ';
        this.scene.add(this.camera);

        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.setPixelRatioForMode(false);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.12;
        this.renderer.setClearColor(0x7e8a93, 1);

        this.canvas = this.renderer.domElement;
        const gameContainer = document.getElementById('game-container');
        if (!gameContainer) throw new Error('Missing #game-container element');
        gameContainer.appendChild(this.canvas);

        this.setupLighting();
        this.createAtmosphere();

        window.addEventListener('resize', () => this.onResize());
        return this;
    }

    setupLighting() {
        this.scene.add(new THREE.AmbientLight(0x445066, 0.34));
        this.scene.add(new THREE.HemisphereLight(0xd8ecff, 0x3f3020, 0.78));

        const sun = new THREE.DirectionalLight(0xffefd2, 1.45);
        sun.position.set(-75, 120, -55);
        sun.target.position.set(0, 0, 0);
        this.scene.add(sun.target);
        sun.castShadow = true;
        sun.shadow.mapSize.width = this.lowFxMode ? 512 : 1024;
        sun.shadow.mapSize.height = this.lowFxMode ? 512 : 1024;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 260;
        sun.shadow.camera.left = -105;
        sun.shadow.camera.right = 105;
        sun.shadow.camera.top = 105;
        sun.shadow.camera.bottom = -105;
        sun.shadow.bias = -0.00025;
        sun.shadow.normalBias = 0.04;
        this.scene.add(sun);
        this.sunLight = sun;

        const coolFill = new THREE.DirectionalLight(0x86b8ff, 0.42);
        coolFill.position.set(80, 45, 90);
        this.scene.add(coolFill);

        const warmRim = new THREE.DirectionalLight(0xff8a4f, 0.28);
        warmRim.position.set(-90, 35, 95);
        this.scene.add(warmRim);

        if (!this.lowFxMode) this.createMapAccentLights();
    }

    setPixelRatioForMode(performanceMode) {
        if (!this.renderer) return;
        const ratio = performanceMode ? 0.85 : Math.min(window.devicePixelRatio || 1, this.lowFxMode ? 1 : 1.35);
        this.renderer.setPixelRatio(ratio);
    }

    setPerformanceMode(enabled) {
        if (this.performanceMode === enabled) return;
        this.performanceMode = enabled;
        this.maxParticles = enabled ? 25 : (this.lowFxMode ? 45 : 90);
        this.setPixelRatioForMode(enabled);
        if (this.dust) this.dust.visible = !enabled && !this.lowFxMode;
        if (this.sunLight) this.sunLight.castShadow = !enabled;
        this.renderer.shadowMap.enabled = !enabled;

        while (this.particles.length > this.maxParticles) {
            const old = this.particles.shift();
            this.scene.remove(old.mesh);
            if (old.material) old.material.dispose();
        }
    }

    createMapAccentLights() {
        const lights = [
            { color: 0x36a4ff, pos: [-64, 5.5, -52], intensity: 1.0, distance: 42 },
            { color: 0xff6842, pos: [62, 5.5, 48], intensity: 0.95, distance: 42 },
            { color: 0xffd266, pos: [0, 6.5, -28], intensity: 0.75, distance: 34 },
            { color: 0x66ffe0, pos: [28, 5.2, 66], intensity: 0.65, distance: 32 },
            { color: 0xff4e7a, pos: [-35, 5.2, 58], intensity: 0.6, distance: 30 }
        ];

        lights.forEach((cfg) => {
            const light = new THREE.PointLight(cfg.color, cfg.intensity, cfg.distance, 2);
            light.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
            this.scene.add(light);

            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(0.14, 10, 10),
                new THREE.MeshBasicMaterial({
                    color: cfg.color,
                    transparent: true,
                    opacity: 0.65,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                })
            );
            marker.position.copy(light.position);
            this.scene.add(marker);
        });
    }

    createAtmosphere() {
        this.flashTexture = createSoftParticleTexture('rgba(255, 230, 150, 1)', 'rgba(255, 130, 45, 0)');

        const count = this.lowFxMode ? 90 : 180;
        this.dustPositions = new Float32Array(count * 3);
        this.dustSpeeds = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const idx = i * 3;
            this.dustPositions[idx] = (Math.random() - 0.5) * 240;
            this.dustPositions[idx + 1] = 0.7 + Math.random() * 28;
            this.dustPositions[idx + 2] = (Math.random() - 0.5) * 240;
            this.dustSpeeds[i] = 0.25 + Math.random() * 0.55;
        }

        const dustGeometry = new THREE.BufferGeometry();
        dustGeometry.setAttribute('position', new THREE.BufferAttribute(this.dustPositions, 3));
        const dustMaterial = new THREE.PointsMaterial({
            color: 0xe2c99b,
            size: 0.38,
            map: createSoftParticleTexture('rgba(255, 238, 200, 0.75)', 'rgba(255, 238, 200, 0)'),
            transparent: true,
            opacity: 0.24,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.dust = new THREE.Points(dustGeometry, dustMaterial);
        this.dust.frustumCulled = false;
        this.scene.add(this.dust);
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    render() {
        const deltaTime = this.game?.deltaTime || 0.016;
        this.updateShake();
        this.updateAtmosphere(deltaTime);
        this.updateParticles(deltaTime);
        this.updateThrowables(deltaTime);
        this.renderer.render(this.scene, this.camera);
    }

    shake(intensity, duration) {
        this.shakeAmount = intensity;
        this.shakeDuration = duration;
    }

    updateShake() {
        if (this.shakeDuration > 0) {
            this.shakeDuration -= 0.016; // Approx 1 frame
            const x = (Math.random() - 0.5) * this.shakeAmount;
            const y = (Math.random() - 0.5) * this.shakeAmount;
            this.camera.position.x += x;
            this.camera.position.y += y;
            this.shakeAmount *= 0.95; // Fade out intensity
        }
    }

    updateAtmosphere(deltaTime) {
        if (!this.dust || !this.dustPositions) return;

        this.dustUpdateTimer += deltaTime;
        if (this.dustUpdateTimer < 0.066) return;
        const stepTime = this.dustUpdateTimer;
        this.dustUpdateTimer = 0;

        const cam = this.camera.position;
        for (let i = 0; i < this.dustSpeeds.length; i++) {
            const idx = i * 3;
            this.dustPositions[idx] += stepTime * this.dustSpeeds[i] * 0.75;
            this.dustPositions[idx + 1] += Math.sin((performance.now() * 0.001) + i) * stepTime * 0.08;
            this.dustPositions[idx + 2] += stepTime * this.dustSpeeds[i] * 0.25;

            if (this.dustPositions[idx] > cam.x + 120) this.dustPositions[idx] -= 240;
            if (this.dustPositions[idx] < cam.x - 120) this.dustPositions[idx] += 240;
            if (this.dustPositions[idx + 2] > cam.z + 120) this.dustPositions[idx + 2] -= 240;
            if (this.dustPositions[idx + 2] < cam.z - 120) this.dustPositions[idx + 2] += 240;
            if (this.dustPositions[idx + 1] > 30) this.dustPositions[idx + 1] = 0.8;
            if (this.dustPositions[idx + 1] < 0.5) this.dustPositions[idx + 1] = 28;
        }
        this.dust.geometry.attributes.position.needsUpdate = true;
    }

    enforceParticleBudget() {
        while (this.particles.length >= this.maxParticles) {
            const old = this.particles.shift();
            if (!old) break;
            this.scene.remove(old.mesh);
            if (old.material) old.material.dispose();
        }
    }

    createParticle(position, velocity, options = {}) {
        this.enforceParticleBudget();
        if (!this.particleGeom) this.particleGeom = new THREE.SphereGeometry(0.04, 6, 6);

        const material = new THREE.MeshBasicMaterial({
            color: options.color || 0xffaa44,
            transparent: true,
            opacity: options.opacity ?? 1,
            depthWrite: false,
            blending: options.blending || THREE.NormalBlending
        });
        const mesh = new THREE.Mesh(options.geometry || this.particleGeom, material);
        const size = options.size || 1;
        mesh.scale.setScalar(size);
        mesh.position.copy(position);
        this.scene.add(mesh);

        this.particles.push({
            mesh,
            material,
            velocity: velocity.clone(),
            gravity: options.gravity ?? 0,
            lifetime: options.lifetime || 0.45,
            age: 0,
            baseOpacity: material.opacity,
            baseScale: mesh.scale.clone(),
            grow: options.grow || 0,
            spin: options.spin || new THREE.Vector3(
                (Math.random() - 0.5) * 8,
                (Math.random() - 0.5) * 8,
                (Math.random() - 0.5) * 8
            )
        });
    }

    createSpriteParticle(position, velocity, options = {}) {
        this.enforceParticleBudget();
        const material = new THREE.SpriteMaterial({
            map: options.map || this.flashTexture,
            color: options.color || 0xffaa44,
            transparent: true,
            opacity: options.opacity ?? 1,
            depthWrite: false,
            blending: options.blending || THREE.AdditiveBlending,
            fog: options.fog ?? true
        });
        const sprite = new THREE.Sprite(material);
        const width = options.width || options.size || 1;
        const height = options.height || options.size || 1;
        sprite.scale.set(width, height, 1);
        sprite.position.copy(position);
        this.scene.add(sprite);

        this.particles.push({
            mesh: sprite,
            material,
            velocity: velocity.clone(),
            gravity: options.gravity ?? 0,
            lifetime: options.lifetime || 0.25,
            age: 0,
            baseOpacity: material.opacity,
            baseScale: sprite.scale.clone(),
            grow: options.grow || 0.2,
            spin: null
        });
    }

    createTemporaryLight(position, color, intensity, distance, lifetime = 0.1) {
        if (this.lowFxMode) return;
        let activeLights = 0;
        for (const particle of this.particles) {
            if (particle.isLight) activeLights++;
        }
        if (activeLights >= 4) return;

        this.enforceParticleBudget();
        const light = new THREE.PointLight(color, intensity, distance, 2);
        light.position.copy(position);
        this.scene.add(light);
        this.particles.push({
            mesh: light,
            velocity: new THREE.Vector3(),
            gravity: 0,
            lifetime,
            age: 0,
            baseIntensity: intensity,
            isLight: true
        });
    }

    updateParticles(deltaTime) {
        if (!this.particles.length) return;

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            particle.age += deltaTime;
            const pct = Math.min(1, particle.age / particle.lifetime);

            particle.mesh.position.addScaledVector(particle.velocity, deltaTime);
            if (particle.gravity) particle.velocity.y -= particle.gravity * deltaTime;

            if (particle.isLight) {
                particle.mesh.intensity = particle.baseIntensity * (1 - pct);
            } else {
                if (particle.spin) {
                    particle.mesh.rotation.x += particle.spin.x * deltaTime;
                    particle.mesh.rotation.y += particle.spin.y * deltaTime;
                    particle.mesh.rotation.z += particle.spin.z * deltaTime;
                }
                particle.material.opacity = particle.baseOpacity * (1 - pct);
                const scale = Math.max(0.05, 1 + particle.grow * pct);
                particle.mesh.scale.copy(particle.baseScale).multiplyScalar(scale);
            }

            if (pct >= 1) {
                this.scene.remove(particle.mesh);
                if (particle.material) particle.material.dispose();
                this.particles.splice(i, 1);
            }
        }
    }

    createMuzzleBurst(position, direction, weaponType) {
        if (!position || !direction || weaponType === 'melee') return;

        const isRPG = weaponType === 'rpg';
        const forward = direction.clone().normalize();
        const origin = position.clone().add(forward.clone().multiplyScalar(isRPG ? 0.95 : 0.55));
        const color = isRPG ? 0xff7040 : 0xffc15a;

        this.createSpriteParticle(origin, forward.clone().multiplyScalar(0.5), {
            color,
            opacity: isRPG ? 0.95 : 0.8,
            size: isRPG ? 1.0 : 0.42,
            lifetime: isRPG ? 0.18 : 0.09,
            grow: isRPG ? 1.0 : 0.55,
            fog: false
        });
        if (isRPG) this.createTemporaryLight(origin, color, 10, 8, 0.14);

        const sparkCount = this.lowFxMode ? (isRPG ? 4 : 0) : (isRPG ? 8 : 2);
        for (let i = 0; i < sparkCount; i++) {
            const scatter = new THREE.Vector3(
                (Math.random() - 0.5) * 1.2,
                (Math.random() - 0.5) * 1.2,
                (Math.random() - 0.5) * 1.2
            );
            const velocity = forward.clone().multiplyScalar(1.5 + Math.random() * 3.0).add(scatter);
            this.createParticle(origin, velocity, {
                color: Math.random() > 0.35 ? 0xffd56b : 0xffffff,
                opacity: 0.9,
                size: isRPG ? 1.15 : 0.7,
                lifetime: 0.12 + Math.random() * 0.18,
                gravity: 1.8,
                blending: THREE.AdditiveBlending
            });
        }
    }

    createMeleeSlash(position, direction) {
        if (!position || !direction || this.lowFxMode) return;

        const forward = direction.clone().normalize();
        const origin = position.clone().add(forward.multiplyScalar(1.15));
        this.createSpriteParticle(origin, new THREE.Vector3(0, 0, 0), {
            color: 0xdfeaff,
            opacity: 0.22,
            width: 1.35,
            height: 0.3,
            lifetime: 0.12,
            grow: 0.25,
            blending: THREE.AdditiveBlending,
            fog: false
        });
    }

    getShurikenAssets() {
        if (!this.shurikenGeometry) {
            const shape = new THREE.Shape();
            const points = 16;
            for (let i = 0; i <= points; i++) {
                const angle = (i / points) * Math.PI * 2 + Math.PI / 8;
                const radius = i % 2 === 0 ? 1.0 : 0.34;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                if (i === 0) shape.moveTo(x, y);
                else shape.lineTo(x, y);
            }
            this.shurikenGeometry = new THREE.ShapeGeometry(shape);
            this.shurikenMaterial = new THREE.MeshStandardMaterial({
                color: 0xc8d3dd,
                roughness: 0.2,
                metalness: 0.9,
                side: THREE.DoubleSide
            });
        }

        return { geometry: this.shurikenGeometry, material: this.shurikenMaterial };
    }

    createThrownShuriken(origin, direction, hitPoint, range = 45) {
        if (!origin || !direction) return;

        const assets = this.getShurikenAssets();
        const forward = direction.clone().normalize();
        const start = origin.clone().add(forward.clone().multiplyScalar(0.75));
        const end = hitPoint ? hitPoint.clone() : origin.clone().add(forward.clone().multiplyScalar(range));
        const travelDistance = Math.max(1, start.distanceTo(end));

        const mesh = new THREE.Mesh(assets.geometry, assets.material);
        mesh.scale.setScalar(0.22);
        mesh.position.copy(start);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward);
        this.scene.add(mesh);

        this.throwables.push({
            mesh,
            direction: forward,
            traveled: 0,
            maxDistance: travelDistance,
            speed: 72
        });

        if (this.throwables.length > 12) {
            const old = this.throwables.shift();
            this.scene.remove(old.mesh);
        }
    }

    updateThrowables(deltaTime) {
        if (!this.throwables.length) return;

        for (let i = this.throwables.length - 1; i >= 0; i--) {
            const item = this.throwables[i];
            const step = item.speed * deltaTime;
            item.mesh.position.addScaledVector(item.direction, step);
            item.mesh.rotateZ(deltaTime * 42);
            item.traveled += step;

            if (item.traveled >= item.maxDistance) {
                this.scene.remove(item.mesh);
                this.throwables.splice(i, 1);
            }
        }
    }

    createBloodEffect(point) {
        const count = this.lowFxMode ? 4 : 7;
        for (let i = 0; i < count; i++) {
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 2.3,
                Math.random() * 1.4 + 0.4,
                (Math.random() - 0.5) * 2.3
            );
            this.createParticle(point, vel, {
                color: Math.random() > 0.35 ? 0x8b0505 : 0x3a0000,
                opacity: 0.85,
                size: 0.9 + Math.random() * 0.9,
                lifetime: 0.35 + Math.random() * 0.25,
                gravity: 5.5
            });
        }
    }
    addToScene(obj) { this.scene.add(obj); }
    removeFromScene(obj) { this.scene.remove(obj); }

    createSparkEffect(point, normal, intensity = 1) {
        const baseNormal = normal ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
        const count = this.lowFxMode ? 0 : Math.round(4 * intensity);

        for (let i = 0; i < count; i++) {
            const scatter = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() * 0.9,
                (Math.random() - 0.5) * 2
            );
            const velocity = baseNormal.clone().multiplyScalar(1.0 + Math.random() * 2.2).add(scatter);
            this.createParticle(point, velocity, {
                color: Math.random() > 0.35 ? 0xffc35a : 0xffffff,
                opacity: 0.95,
                size: 0.55 + Math.random() * 0.8,
                lifetime: 0.2 + Math.random() * 0.28,
                gravity: 6.5,
                blending: THREE.AdditiveBlending
            });
        }
        if (intensity > 1.2) this.createTemporaryLight(point, 0xffaa55, 1.6 * intensity, 3.5 * intensity, 0.07);
    }

    createExplosionEffect(position) {
        this.createSpriteParticle(position, new THREE.Vector3(0, 0.4, 0), {
            color: 0xff7a34,
            opacity: 0.9,
            size: 4.6,
            lifetime: 0.42,
            grow: 1.4,
            fog: false
        });
        this.createTemporaryLight(position, 0xff6a24, 14, 13, 0.22);

        const count = this.lowFxMode ? 10 : 18;
        for (let i = 0; i < count; i++) {
            const velocity = new THREE.Vector3(
                (Math.random() - 0.5) * 10,
                Math.random() * 7,
                (Math.random() - 0.5) * 10
            );
            const hot = Math.random() > 0.45;
            this.createParticle(position, velocity, {
                color: hot ? 0xffc15a : 0x5b5048,
                opacity: hot ? 0.95 : 0.45,
                size: hot ? 1.2 : 2.2,
                lifetime: hot ? 0.45 + Math.random() * 0.35 : 0.9 + Math.random() * 0.6,
                gravity: hot ? 6.5 : 1.2,
                blending: hot ? THREE.AdditiveBlending : THREE.NormalBlending
            });
        }
    }

    createImpact(point, normal) {
        if (!point || !normal) return;
        if (!this.impacts) this.impacts = [];
        if (!this.impactGeom) this.impactGeom = new THREE.CircleGeometry(0.075, 18);

        const material = new THREE.MeshBasicMaterial({
            color: 0x191512,
            transparent: true,
            opacity: 0.78,
            side: THREE.DoubleSide
        });
        const impact = new THREE.Mesh(this.impactGeom, material);

        const hitNormal = normal.clone().normalize();
        impact.position.copy(point).add(hitNormal.clone().multiplyScalar(0.012));
        impact.lookAt(point.clone().add(hitNormal));

        this.scene.add(impact);
        this.impacts.push({ mesh: impact, time: 0, lifetime: 2.5, fadeStart: 1.6 });
        this.createSparkEffect(point, hitNormal);

        // Limit impacts to prevent lag
        const maxImpacts = this.lowFxMode ? 10 : 18;
        if (this.impacts.length > maxImpacts) {
            const old = this.impacts.shift();
            this.scene.remove(old.mesh);
            old.mesh.material.dispose();
        }
    }

    updateImpacts(deltaTime) {
        if (!this.impacts) return;
        for (let i = this.impacts.length - 1; i >= 0; i--) {
            const imp = this.impacts[i];
            imp.time += deltaTime;
            if (imp.time > imp.fadeStart) {
                const fadePct = (imp.time - imp.fadeStart) / (imp.lifetime - imp.fadeStart);
                imp.mesh.material.opacity = 0.78 * (1 - fadePct);
            }
            if (imp.time > imp.lifetime) {
                this.scene.remove(imp.mesh);
                imp.mesh.material.dispose();
                this.impacts.splice(i, 1);
            }
        }
    }
}

// ==================== INPUT MANAGER ====================
class InputManager {
    constructor(game) {
        this.game = game;
        this.keys = { forward: false, backward: false, left: false, right: false, jump: false, sprint: false, crouch: false, tab: false };
        this.mouse = { dx: 0, dy: 0, leftButton: false, rightButton: false };
        this.isPointerLocked = false;

        // Mobile detection
        this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        this.setupEvents();
        if (this.isMobile) {
            this.setupMobileControls();
        }
    }

    setupEvents() {
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('keyup', (e) => this.onKeyUp(e));
        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
        document.addEventListener('mousedown', (e) => this.onMouseDown(e));
        document.addEventListener('mouseup', (e) => this.onMouseUp(e));
        document.addEventListener('pointerlockchange', () => this.onPointerLockChange());

        this.game.renderer.canvas.addEventListener('click', () => {
            if (!this.isMobile && this.game.gameState === 'playing' && !this.isPointerLocked) {
                this.game.renderer.canvas.requestPointerLock();
            }
        });
    }

    setupMobileControls() {
        debugLog('[INPUT] Initializing Mobile Controls');
        const mobileControls = document.getElementById('mobile-controls');
        if (mobileControls) mobileControls.classList.remove('hidden');

        // Joystick
        const joystickZone = document.getElementById('joystick-zone');
        const joystickKnob = document.getElementById('joystick-knob');
        let joystickTouchId = null;
        let joystickCenter = { x: 0, y: 0 };
        const maxRadius = 50;

        joystickZone.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.changedTouches[0];
            joystickTouchId = touch.identifier;
            const rect = joystickZone.getBoundingClientRect();
            joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            this.updateJoystick(touch.clientX, touch.clientY, joystickKnob, maxRadius);
        }, { passive: false });

        joystickZone.addEventListener('touchmove', (e) => {
            e.preventDefault();
            for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === joystickTouchId) {
                    this.updateJoystick(e.changedTouches[i].clientX, e.changedTouches[i].clientY, joystickKnob, maxRadius);
                    break;
                }
            }
        }, { passive: false });

        joystickZone.addEventListener('touchend', (e) => {
            e.preventDefault();
            for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === joystickTouchId) {
                    joystickTouchId = null;
                    joystickKnob.style.transform = `translate(-50%, -50%)`;
                    this.keys.forward = false;
                    this.keys.backward = false;
                    this.keys.left = false;
                    this.keys.right = false;
                    this.keys.sprint = false; // Reset sprint
                    break;
                }
            }
        }, { passive: false });

        // Touch Look (Swipe anywhere else)
        let lastLookX = 0;
        let lastLookY = 0;

        document.addEventListener('touchstart', (e) => {
            // Find a touch that is NOT the joystick or buttons
            // Simplified: if target is canvas, use it for look
            if (e.target === this.game.renderer.canvas) {
                const touch = e.changedTouches[0];
                lastLookX = touch.clientX;
                lastLookY = touch.clientY;
            }
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (e.target === this.game.renderer.canvas) {
                // Prevent default scrolling
                if (e.cancelable) e.preventDefault();

                const touch = e.changedTouches[0];
                const dx = touch.clientX - lastLookX;
                const dy = touch.clientY - lastLookY;

                if (this.game.gameState === 'playing') {
                    // Mobile sensitivity multiplier
                    const sens = this.game.settings.sensitivity * 0.005;
                    this.game.player.look(dx * sens, dy * sens);
                }

                lastLookX = touch.clientX;
                lastLookY = touch.clientY;
            }
        }, { passive: false });

        // Buttons
        const bindButton = (id, startAction, endAction) => {
            const btn = document.getElementById(id);
            if (!btn) return;

            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation(); // Prevent look logic
                btn.classList.add('active');
                startAction();
            }, { passive: false });

            btn.addEventListener('touchend', (e) => {
                e.preventDefault();
                btn.classList.remove('active');
                if (endAction) endAction();
            }, { passive: false });
        };

        bindButton('btn-mobile-shoot',
            () => { this.game.player.startShooting(); },
            () => { this.game.player.stopShooting(); }
        );

        bindButton('btn-mobile-jump', () => { this.keys.jump = true; }, () => { this.keys.jump = false; });
        bindButton('btn-mobile-reload', () => { this.game.player.reload(); });

        // Toggle Aim
        bindButton('btn-mobile-aim', () => {
            if (this.game.player.isAiming) this.game.player.stopAiming();
            else this.game.player.startAiming();
        });

        // Cycle Weapons
        bindButton('btn-mobile-switch', () => {
            let nextIndex = (this.game.player.currentWeaponIndex + 1) % this.game.player.weapons.length;
            this.game.player.switchWeapon(nextIndex);
        });
    }

    updateJoystick(x, y, knob, maxRadius) {
        // Calculate vector from center
        const joystickZone = document.getElementById('joystick-zone');
        const rect = joystickZone.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let deltaX = x - centerX;
        let deltaY = y - centerY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        // Clamping
        if (distance > maxRadius) {
            const angle = Math.atan2(deltaY, deltaX);
            deltaX = Math.cos(angle) * maxRadius;
            deltaY = Math.sin(angle) * maxRadius;
        }

        // Apply visual
        knob.style.transform = `translate(calc(-50% + ${deltaX}px), calc(-50% + ${deltaY}px))`;

        // Map to Keys
        const threshold = 10;
        this.keys.right = deltaX > threshold;
        this.keys.left = deltaX < -threshold;
        this.keys.backward = deltaY > threshold;
        this.keys.forward = deltaY < -threshold;

        // Sprint if pushed far up
        this.keys.sprint = deltaY < -maxRadius * 0.8;
    }

    onKeyDown(e) {
        if (['Space', 'Tab', 'ControlLeft', 'ControlRight'].includes(e.code)) e.preventDefault();
        const keyMap = {
            KeyW: 'forward', KeyS: 'backward', KeyA: 'left', KeyD: 'right',
            Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
            ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
            Tab: 'tab'
        };
        if (keyMap[e.code]) this.keys[keyMap[e.code]] = true;

        if (e.code === 'KeyR' && this.game.gameState === 'playing') this.game.player.reload();
        if (e.code === 'Digit1' && this.game.gameState === 'playing') this.game.player.switchWeapon(0);
        if (e.code === 'Digit2' && this.game.gameState === 'playing') this.game.player.switchWeapon(1);
        if (e.code === 'Digit3' && this.game.gameState === 'playing') this.game.player.switchWeapon(2);
        if (e.code === 'Digit4' && this.game.gameState === 'playing') this.game.player.switchWeapon(3);
        if (e.code === 'Digit5' && this.game.gameState === 'playing') this.game.player.switchWeapon(4);
        if (e.code === 'Digit6' && this.game.gameState === 'playing') this.game.player.switchWeapon(5);
        if (e.code === 'Digit7' && this.game.gameState === 'playing') this.game.player.switchWeapon(6);
        if (e.code === 'KeyQ' && this.game.gameState === 'playing') {
            const player = this.game.player;
            if (player.previousWeaponIndex !== undefined && player.previousWeaponIndex !== player.currentWeaponIndex) {
                player.switchWeapon(player.previousWeaponIndex);
            }
        }
        if (e.code === 'Escape') {
            if (this.game.gameState === 'playing') this.game.pauseGame();
            else if (this.game.gameState === 'paused') this.game.resumeGame();
        }
    }

    onKeyUp(e) {
        const keyMap = {
            KeyW: 'forward', KeyS: 'backward', KeyA: 'left', KeyD: 'right',
            Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
            ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
            Tab: 'tab'
        };
        if (keyMap[e.code]) this.keys[keyMap[e.code]] = false;
    }

    onMouseMove(e) {
        if (this.isPointerLocked && this.game.gameState === 'playing') {
            this.game.player.look(e.movementX * this.game.settings.sensitivity * 0.002, e.movementY * this.game.settings.sensitivity * 0.002);
        }
    }

    onMouseDown(e) {
        if (e.button === 0) { this.mouse.leftButton = true; if (this.game.gameState === 'playing' && (this.isPointerLocked || this.isMobile)) this.game.player.startShooting(); }
        if (e.button === 2) {
            this.mouse.rightButton = true;
            if (this.game.gameState === 'playing' && (this.isPointerLocked || this.isMobile)) {
                const currentWeapon = this.game.player.weapons[this.game.player.currentWeaponIndex];

                // Sniper always allowed to toggle ADS
                if (currentWeapon?.type === 'sniper') {
                    if (this.game.player.isAiming) {
                        this.game.player.stopAiming();
                    } else {
                        this.game.player.startAiming();
                    }
                }
                // Other weapons only allowed if setting is enabled (hold to ADS)
                else if (this.game.settings.allowNonSniperAds) {
                    this.game.player.startAiming();
                }
            }
        }
    }

    onMouseUp(e) {
        if (e.button === 0) { this.mouse.leftButton = false; this.game.player?.stopShooting(); }
        if (e.button === 2) {
            this.mouse.rightButton = false;
            // Stop aiming for non-sniper weapons on release (if it was enabled)
            const currentWeapon = this.game.player?.weapons[this.game.player.currentWeaponIndex];
            if (currentWeapon?.type !== 'sniper') {
                this.game.player?.stopAiming();
            }
        }
    }

    onPointerLockChange() {
        this.isPointerLocked = document.pointerLockElement === this.game.renderer.canvas;
        const instructions = document.getElementById('pointer-lock-instructions');
        if (instructions) {
            instructions.classList.toggle('hidden', this.isPointerLocked || this.game.gameState !== 'playing' || this.isMobile);
        }
    }
}

// ==================== UI MANAGER ====================
class UIManager {
    constructor(game) {
        this.game = game;
    }

    init() {
        // Cache elements
        this.healthFill = document.getElementById('health-fill');
        this.healthText = document.getElementById('health-text');
        this.currentAmmo = document.getElementById('current-ammo');
        this.reserveAmmo = document.getElementById('reserve-ammo');
        this.weaponName = document.getElementById('weapon-name');
        this.scoreValue = document.getElementById('score-value');
        this.killFeed = document.getElementById('kill-feed');
        this.enemiesRemaining = document.getElementById('enemies-remaining');
        this.reloadIndicator = document.getElementById('reload-indicator');
        this.reloadProgress = document.getElementById('reload-progress');
        this.hitMarker = document.getElementById('hit-marker');
        this.damageOverlay = document.getElementById('damage-overlay');
        this.crosshair = document.getElementById('crosshair');

        this.setupMenuListeners();
        this.setupSettingsListeners();
    }

    setupMenuListeners() {
        const addListener = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };

        // Main menu navigation is wired after initialization, because it depends on
        // name and game-mode dialogs. Keep only in-match controls here.
        addListener('btn-resume', () => this.game.resumeGame());
        addListener('btn-restart', () => this.game.restartGame());
        addListener('btn-main-menu', () => {
            document.getElementById('pause-menu')?.classList.add('hidden');
            this.game.showMainMenu();
        });
        addListener('btn-respawn', () => this.game.restartGame());
        addListener('btn-death-menu', () => {
            document.getElementById('death-screen')?.classList.add('hidden');
            this.game.showMainMenu();
        });
        addListener('btn-play-again', () => this.game.restartGame());
        addListener('btn-victory-menu', () => {
            document.getElementById('victory-screen')?.classList.add('hidden'); // Note: victory-screen might be match-end-screen in HTML
            document.getElementById('match-end-screen')?.classList.add('hidden');
            this.game.showMainMenu();
        });

        // Scoreboard elements
        this.scoreboardOverlay = document.getElementById('scoreboard-overlay');
        this.scoreboardBody = document.getElementById('scoreboard-body');
    }

    setupSettingsListeners() {
        const addInputListener = (id, event, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, fn);
        };

        addInputListener('sensitivity', 'input', (e) => {
            this.game.settings.sensitivity = parseFloat(e.target.value);
            const val = document.getElementById('sensitivity-value');
            if (val) val.textContent = this.game.settings.sensitivity.toFixed(1);
        });

        addInputListener('volume', 'input', (e) => {
            this.game.settings.volume = parseFloat(e.target.value);
            const val = document.getElementById('volume-value');
            if (val) val.textContent = Math.round(this.game.settings.volume * 100) + '%';
        });

        addInputListener('crosshair-color', 'change', (e) => {
            this.game.settings.crosshairColor = e.target.value;
            this.game.uiManager.updateCrosshairColor(e.target.value);
        });

        addInputListener('show-fps', 'change', (e) => {
            this.game.settings.showFps = e.target.checked;
            const counter = document.getElementById('fps-counter');
            if (counter) counter.classList.toggle('hidden', !e.target.checked);
        });

        addInputListener('show-minimap', 'change', (e) => {
            this.game.settings.showMinimap = e.target.checked;
            const map = document.getElementById('minimap-container');
            if (map) map.classList.toggle('hidden', !e.target.checked);
        });
        addInputListener('enable-ads', 'change', (e) => {
            this.game.settings.allowNonSniperAds = e.target.checked;
        });
    }


    update(deltaTime) {
        // Handle Scoreboard visibility
        if (!this.scoreboardOverlay || !this.game.inputManager) return;
        const isTabPressed = this.game.inputManager.keys.tab;
        if (isTabPressed && this.game.gameState === 'playing') {
            this.scoreboardOverlay.classList.remove('hidden');
        } else {
            this.scoreboardOverlay.classList.add('hidden');
        }
    }

    renderScoreboard(players, myId) {
        if (!this.scoreboardBody) return;

        const sortedPlayers = Array.isArray(players) ? [...players] : Object.values(players);
        sortedPlayers.sort((a, b) => (b.kills || 0) - (a.kills || 0));
        const rows = document.createDocumentFragment();

        sortedPlayers.forEach((p, index) => {
            const isMe = p.id === myId || p.id === this.game.networkManager?.socket?.id;
            const kills = Number(p.kills) || 0;
            const deaths = Number(p.deaths) || 0;
            const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
            const row = document.createElement('tr');
            if (isMe) row.classList.add('me');

            [index + 1, p.name || (isMe ? 'YOU' : 'Player'), kills, deaths, kd, `${Number(p.ping) || 0}ms`].forEach(value => {
                const cell = document.createElement('td');
                cell.textContent = value;
                row.appendChild(cell);
            });
            rows.appendChild(row);
        });

        this.scoreboardBody.replaceChildren(rows);
    }

    updateHealth(current, max) {
        if (current === undefined || current === null || isNaN(current)) current = 0;
        const pct = Math.max(0, Math.min(100, (current / max) * 100));
        if (this.healthFill) this.healthFill.style.width = `${pct}%`;
        if (this.healthText) this.healthText.textContent = Math.ceil(current);
        if (this.healthFill) this.healthFill.classList.toggle('low', pct <= 25);
    }

    updateAmmo(current, reserve, name) {
        if (this.currentAmmo) {
            this.currentAmmo.textContent = current;
            const numericAmmo = Number(current);
            this.currentAmmo.classList.toggle('low', Number.isFinite(numericAmmo) && numericAmmo <= 5);
        }
        if (this.reserveAmmo) this.reserveAmmo.textContent = reserve;
        if (this.weaponName) this.weaponName.textContent = name;
    }

    updateWeaponSlot(index) {
        document.querySelectorAll('.weapon-slot').forEach((s, i) => s.classList.toggle('active', i === index));
    }

    updateScore(score) { if (this.scoreValue) this.scoreValue.textContent = score; }
    updateEnemyCount(count) { if (this.enemiesRemaining) this.enemiesRemaining.textContent = count; }

    addKillFeed(msg, type = '') {
        if (!this.killFeed) return;
        const entry = document.createElement('div');
        entry.className = `kill-entry ${type}`;
        entry.textContent = msg;
        this.killFeed.appendChild(entry);
        if (this.killFeed.children.length > 8) this.killFeed.removeChild(this.killFeed.firstChild);
        setTimeout(() => entry.remove(), 4000);
    }

    showReload(duration) {
        if (!this.reloadIndicator || !this.reloadProgress) return;
        this.reloadIndicator.classList.remove('hidden');
        this.reloadProgress.style.width = '0%';
        const start = Date.now();
        const update = () => {
            const pct = Math.min(((Date.now() - start) / duration) * 100, 100);
            this.reloadProgress.style.width = `${pct}%`;
            if (pct < 100) requestAnimationFrame(update);
            else this.reloadIndicator.classList.add('hidden');
        };
        update();
    }

    showHitMarker(headshot) {
        if (!this.hitMarker) return;
        this.hitMarker.classList.remove('hidden');
        this.hitMarker.classList.add('show');
        if (headshot) this.hitMarker.classList.add('headshot');
        setTimeout(() => { this.hitMarker.classList.remove('show', 'headshot'); this.hitMarker.classList.add('hidden'); }, 200);
    }

    showDamage() {
        if (!this.damageOverlay) return;
        this.damageOverlay.classList.add('active');
        setTimeout(() => this.damageOverlay.classList.remove('active'), 300);
    }

    updateCrosshairColor(color) {
        if (!this.crosshair) return;
        this.crosshair.classList.remove('white', 'red', 'cyan', 'yellow');
        if (color && color !== 'green') this.crosshair.classList.add(color);
    }

    setAiming(aiming) {
        if (this.crosshair) this.crosshair.classList.toggle('aiming', aiming);
    }
}

// ==================== NETWORK MANAGER ====================
class NetworkManager {
    constructor(game) {
        this.game = game;
        this.socket = null;
        this.connected = false;
        this.playerId = null;
        this.playerName = 'Player';
        this.remotePlayers = {};
        this.emitTimer = 0;
        this.emitInterval = 0.05;
        this.pingTimer = 0;
        this.lastPingTime = 0;
        this.latency = 0;
        this.playerCreationQueue = [];
        this.isProcessingQueue = false;
        this.sharedMaterials = null;

        // Match state
        this.matchActive = false;
        this.matchTimeRemaining = 0;
        this.killLimit = 30;
        this.myKills = 0;
        this.myDeaths = 0;
        this.myTeam = null; // Track local team
        this.spawnProtectionUntil = 0;
        this.drops = {};
    }

    getSharedMaterials() {
        if (!this.sharedMaterials) {
            this.sharedMaterials = {
                bodyMat: new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.7 }),
                headMat: new THREE.MeshStandardMaterial({ color: 0xddaa88 }),
                gunMat: new THREE.MeshStandardMaterial({ color: 0x333333 }),
                healthBgMat: new THREE.MeshBasicMaterial({ color: 0x000000 })
            };
        }
        return this.sharedMaterials;
    }

    init() {
        if (typeof io === 'undefined') { console.warn('Socket.io not available'); return; }

        this.socket = io({ reconnectionAttempts: 5, reconnectionDelay: 1000, timeout: 10000 });

        this.socket.on('connect', () => {
            this.connected = true;
            this.playerId = this.socket.id;
            this.socket.emit('setName', this.playerName);
            this.game.uiManager?.addKillFeed('Connected to server', 'system');
        });

        this.socket.on('init', (data) => {
            this.killLimit = data.config?.killLimit || 30;
            const spawnProt = data.config?.spawnProtection !== undefined ? data.config.spawnProtection : 3000;
            this.spawnProtectionUntil = Date.now() + spawnProt;

            this.matchActive = data.matchActive;
            this.matchTimeRemaining = data.matchTimeRemaining || 600;

            // Sync local player if data provided
            const myData = data.players[data.playerId];
            if (myData && this.game.player) {
                debugLog(`[INIT] Syncing Player: pos=(${myData.x.toFixed(1)}, ${myData.z.toFixed(1)}), health=${myData.health}`);
                this.game.player.position.set(myData.x, myData.y, myData.z);
                this.game.player.health = myData.health !== undefined ? myData.health : 100;
                this.game.uiManager?.updateHealth(this.game.player.health, this.game.player.maxHealth);
            }

            Object.keys(data.players).forEach(id => {
                if (id !== data.playerId && id !== this.socket.id) {
                    this.queuePlayerCreation(data.players[id]);
                }
            });

            // Load drops
            if (data.drops) {
                Object.values(data.drops).forEach(dropData => {
                    if (!this.drops[dropData.id]) {
                        this.drops[dropData.id] = new LootDrop(this.game, dropData.id, dropData.x, dropData.y, dropData.z);
                    }
                });
            }

            this.updateMatchUI();
            this.updateSpawnProtectionUI();
        });

        this.socket.on('serverFull', () => {
            this.game.uiManager?.addKillFeed('Server full!', 'system');
            this.connected = false;
        });

        this.socket.on('playerJoined', (info) => {
            debugLog(`[NET] Player Joined: ${info.name} (${info.id})`);
            this.queuePlayerCreation(info);
            this.game.uiManager?.addKillFeed(`${info.name || 'Player'} joined`, 'system');
        });

        this.socket.on('stateUpdate', (players) => {
            const playerIds = Object.keys(players);
            // Optional: console.debug(`[NET] State Update for ${playerIds.length} players`);

            playerIds.forEach(id => {
                if (id !== this.socket.id && id !== this.playerId) {
                    if (this.remotePlayers[id]) {
                        this.remotePlayers[id].updatePosition(players[id]);
                    } else {
                        // Catch-up: Add player if they were missed
                        this.queuePlayerCreation(players[id]);
                    }
                }
            });
        });

        this.socket.on('playerLeft', (id) => {
            this.removeRemotePlayer(id);
            this.playerCreationQueue = this.playerCreationQueue.filter(p => p.id !== id);
        });

        this.socket.on('disconnect', () => {
            this.connected = false;
            this.removeAllRemotePlayers();
            this.playerCreationQueue = [];
        });

        this.socket.on('playerShot', (data) => {
            const id = typeof data === 'string' ? data : data.playerId;
            if (this.remotePlayers[id]) this.remotePlayers[id].visualShoot();
        });

        this.socket.on('takeDamage', (data) => {
            if (this.isSpawnProtected()) return;
            this.game.player?.takeDamage(data.damage, data.attackerId);
        });

        this.socket.on('hitConfirmed', (data) => {
            this.game.uiManager?.showHitMarker(data.isHeadshot);
            this.game.audioManager?.playSound('hit');
            if (data.isHeadshot) this.showHeadshotNotification();
        });

        this.socket.on('hitBlocked', (data) => {
            if (data.reason === 'spawn_protection') {
                this.game.uiManager?.addKillFeed('Target is spawn protected!', 'system');
            }
        });

        this.socket.on('playerKilled', (data) => {
            const isMyKill = data.killerId === this.socket.id;
            const isMyDeath = data.victimId === this.socket.id;

            if (isMyKill) {
                this.myKills++;
                this.showKillNotification(data.victimName, data.isHeadshot);
            }
            if (isMyDeath) {
                this.myDeaths++;
                this.showDeathScreen(data.killerName);

                // Show respawn countdown
                let countDown = 2;
                const countdownEl = document.getElementById('respawn-countdown');
                if (countdownEl) {
                    countdownEl.classList.remove('hidden');
                    const updateCountdown = () => {
                        if (countdownEl) {
                            countdownEl.textContent = Math.max(0, countDown).toString();
                        }
                        countDown--;
                        if (countDown >= 0) {
                            setTimeout(updateCountdown, 1000);
                        } else if (countdownEl) {
                            countdownEl.classList.add('hidden');
                        }
                    };
                    updateCountdown();
                }
            }

            const msg = data.isHeadshot
                ? `${data.killerName} ⊕ ${data.victimName}`
                : `${data.killerName} → ${data.victimName}`;
            this.game.uiManager?.addKillFeed(msg, data.isHeadshot ? 'headshot' : '');
            this.updateMatchUI();
        });

        this.socket.on('respawn', (data) => {
            if (!this.game.player) return;
            try {
                this.game.player.position.set(data.x, data.y, data.z);
                this.game.player.health = 100;
                this.game.player.restoreAmmo();
                this.game.uiManager?.updateHealth(100, this.game.player.maxHealth);
                this.game.player.isDead = false;
                this.game.gameState = 'playing';
                this.game.isPaused = false;
                this.spawnProtectionUntil = Date.now() + (data.spawnProtection !== undefined ? data.spawnProtection : 3000);
                debugLog(`[NET] Respawned! Spawn Protection active for ${((this.spawnProtectionUntil - Date.now()) / 1000).toFixed(1)}s`);
                this.hideDeathScreen();
                const gameHud = document.getElementById('game-hud');
                if (gameHud) gameHud.classList.remove('hidden');
                this.updateSpawnProtectionUI();
            } catch (e) {
                console.error('Respawn error:', e.message);
            }
        });

        this.socket.on('teamScoreUpdate', (scores) => {
            const red = document.getElementById('red-score-val');
            const blue = document.getElementById('blue-score-val');
            if (red) red.textContent = scores.red;
            if (blue) blue.textContent = scores.blue;
        });

        this.socket.on('teamSelected', (data) => {
            if (!data || !this.game.player) return;
            this.myTeam = data.team || this.myTeam;
            this.spawnProtectionUntil = Date.now() + (data.spawnProtection !== undefined ? data.spawnProtection : 3000);
            this.game.player.position.set(Number(data.x) || 0, Number(data.y) || 1.7, Number(data.z) || 0);
            this.game.player.health = 100;
            this.game.player.isDead = false;
            this.game.player.velocity.set(0, 0, 0);
            this.game.player.updateCamera();
            this.game.uiManager?.updateHealth(100, this.game.player.maxHealth);
            this.updateSpawnProtectionUI();
        });

        this.socket.on('matchStart', (data) => {
            this.matchActive = true;
            this.killLimit = data.killLimit;
            this.myKills = 0;
            this.myDeaths = 0;

            // Sync players for new match
            if (data.players) {
                const myData = data.players[this.socket.id] || data.players[this.playerId];
                if (myData && this.game.player) {
                    this.game.player.position.set(myData.x, myData.y, myData.z);
                    this.game.player.health = 100;
                }
            }

            this.game.uiManager?.addKillFeed('Match started!', 'system');
            this.updateMatchUI();
        });

        this.socket.on('matchTimer', (remaining) => {
            this.matchTimeRemaining = remaining;
            this.updateTimerUI();
        });

        this.socket.on('matchEnd', (data) => {
            this.matchActive = false;
            this.showMatchEndScreen(data);
        });

        this.socket.on('leaderboard', (data) => {
            this.game.uiManager?.renderScoreboard(data, this.socket.id);
        });

        this.socket.on('killfeed', (entry) => {
            this.game.uiManager?.addKillFeed(entry.message, '');
        });

        this.socket.on('chatMessage', (data) => {
            this.addChatMessage(data.playerName, data.message);
        });

        this.socket.on('pong', () => {
            this.latency = Date.now() - this.lastPingTime;
            this.socket.emit('latency', this.latency);
            this.updatePingUI();
        });

        this.socket.on('dropSpawned', (drop) => {
            if (!this.drops[drop.id]) {
                this.drops[drop.id] = new LootDrop(this.game, drop.id, drop.x, drop.y, drop.z);
            }
        });

        this.socket.on('dropCollected', (data) => {
            if (this.drops[data.dropId]) {
                this.drops[data.dropId].destroy();
                delete this.drops[data.dropId];
            }
            if (data.playerId === this.socket.id && this.game.player) {
                this.game.player.health = 100;
                this.game.player.restoreAmmo();
                this.game.uiManager?.updateHealth(100, this.game.player.maxHealth);
                this.game.uiManager?.addKillFeed('Picked up loot! HP & Ammo restored.', 'system');
                this.game.audioManager?.playSound('reload');
            }
        });
    }

    setPlayerName(name) {
        this.playerName = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>]/g, '').trim().substring(0, 16) || 'Player';
        if (this.connected) this.socket.emit('setName', this.playerName);
    }

    sendChatMessage(message) {
        if (this.connected && message.trim()) {
            this.socket.emit('chatMessage', message.trim());
        }
    }

    addChatMessage(name, message) {
        const container = document.getElementById('chat-messages');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'chat-message';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'player-name';
        nameSpan.textContent = `${name || 'Player'}:`;
        div.appendChild(nameSpan);
        div.appendChild(document.createTextNode(` ${message || ''}`));
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        if (container.children.length > 50) container.removeChild(container.firstChild);
    }

    isSpawnProtected() {
        return Date.now() < this.spawnProtectionUntil;
    }

    updateSpawnProtectionUI() {
        const el = document.getElementById('spawn-protection');
        if (el) el.classList.toggle('hidden', !this.isSpawnProtected());
    }

    updateMatchUI() {
        const killsEl = document.getElementById('my-kills');
        const limitEl = document.getElementById('kill-limit');
        if (killsEl) killsEl.textContent = this.myKills;
        if (limitEl) limitEl.textContent = this.killLimit;
    }

    updateTimerUI() {
        const mins = Math.floor(this.matchTimeRemaining / 60);
        const secs = this.matchTimeRemaining % 60;
        const timerEl = document.getElementById('timer-value');
        const sbTimer = document.getElementById('scoreboard-timer');
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        if (timerEl) {
            timerEl.textContent = timeStr;
            timerEl.classList.toggle('warning', this.matchTimeRemaining <= 60);
            timerEl.classList.toggle('critical', this.matchTimeRemaining <= 10);
        }
        if (sbTimer) sbTimer.textContent = timeStr;
    }

    updatePingUI() {
        const el = document.getElementById('ping-display');
        if (el) {
            el.textContent = `PING: ${this.latency}ms`;
            el.classList.toggle('high', this.latency > 100);
            el.classList.toggle('critical', this.latency > 200);
        }
    }

    showKillNotification(victimName, isHeadshot) {
        const el = document.getElementById('kill-notification');
        const text = document.getElementById('kill-notification-text');
        if (el && text) {
            text.textContent = `You eliminated ${victimName}`;
            el.classList.remove('hidden');
            setTimeout(() => el.classList.add('hidden'), 2000);
        }
        if (isHeadshot) this.showHeadshotNotification();
    }

    showHeadshotNotification() {
        const el = document.getElementById('headshot-notification');
        if (el) {
            el.classList.remove('hidden');
            setTimeout(() => el.classList.add('hidden'), 1500);
        }
    }

    showDeathScreen(killerName) {
        const screen = document.getElementById('death-screen');
        const killerEl = document.getElementById('killer-name');
        const killsEl = document.getElementById('death-kills');
        const deathsEl = document.getElementById('death-deaths');
        if (screen) screen.classList.remove('hidden');
        if (killerEl) killerEl.textContent = killerName;
        if (killsEl) killsEl.textContent = this.myKills;
        if (deathsEl) deathsEl.textContent = this.myDeaths;

        const respawnBtn = document.getElementById('btn-respawn');
        if (respawnBtn) {
            if (this.game.networkManager?.connected) {
                respawnBtn.style.display = 'none';
            } else {
                respawnBtn.style.display = 'block';
            }
        }
    }

    hideDeathScreen() {
        const screen = document.getElementById('death-screen');
        if (screen) screen.classList.add('hidden');
    }

    showMatchEndScreen(data) {
        const screen = document.getElementById('match-end-screen');
        const title = document.getElementById('match-end-title');
        const winner = document.getElementById('winner-name');
        const stats = document.getElementById('match-end-stats');

        if (screen) screen.classList.remove('hidden');
        if (title) title.textContent = data.winnerId === this.socket.id ? 'VICTORY!' : 'MATCH OVER';
        if (winner) winner.textContent = data.winnerName;
        if (stats) {
            const rows = document.createDocumentFragment();
            (Array.isArray(data.stats) ? data.stats : []).forEach((p, i) => {
                const row = document.createElement('div');
                row.className = 'player-row';
                if (p.id === this.socket.id) row.classList.add('me');
                if (i === 0) row.classList.add('winner');

                const name = document.createElement('span');
                name.textContent = `#${i + 1} ${p.name || 'Player'}`;
                const score = document.createElement('span');
                score.textContent = `${Number(p.kills) || 0} kills / ${Number(p.deaths) || 0} deaths`;
                row.append(name, score);
                rows.appendChild(row);
            });
            stats.replaceChildren(rows);
        }

        setTimeout(() => screen?.classList.add('hidden'), 10000);
    }

    queuePlayerCreation(info) {
        if (this.remotePlayers[info.id] || this.playerCreationQueue.find(p => p.id === info.id)) return;
        this.playerCreationQueue.push(info);
        this.processCreationQueue();
    }

    processCreationQueue() {
        if (this.isProcessingQueue || this.playerCreationQueue.length === 0) return;
        this.isProcessingQueue = true;
        const processNext = () => {
            if (this.playerCreationQueue.length === 0) { this.isProcessingQueue = false; return; }
            const info = this.playerCreationQueue.shift();
            if (info && !this.remotePlayers[info.id]) this.addRemotePlayer(info);
            if (this.playerCreationQueue.length > 0) requestAnimationFrame(processNext);
            else this.isProcessingQueue = false;
        };
        requestAnimationFrame(processNext);
    }

    addRemotePlayer(info) {
        if (this.remotePlayers[info.id]) return;
        this.remotePlayers[info.id] = new RemotePlayer(this.game, info, this.getSharedMaterials());
    }

    removeRemotePlayer(id) {
        if (this.remotePlayers[id]) { this.remotePlayers[id].destroy(); delete this.remotePlayers[id]; }
    }

    removeAllRemotePlayers() {
        Object.keys(this.remotePlayers).forEach(id => this.removeRemotePlayer(id));
    }

    update(deltaTime) {
        for (const id in this.remotePlayers) {
            this.remotePlayers[id].update(deltaTime);
        }

        // Update drops and check for pickups
        for (const id in this.drops) {
            const drop = this.drops[id];
            drop.update(deltaTime);
            if (this.game.player && !this.game.player.isDead) {
                const distSq = this.game.player.position.distanceToSquared(drop.position);
                if (distSq < 3.24) {
                    this.socket.emit('pickupDrop', drop.id);
                }
            }
        }

        // Update spawn protection
        if (this.isSpawnProtected()) {
            this.updateSpawnProtectionUI();
        } else {
            const el = document.getElementById('spawn-protection');
            if (el && !el.classList.contains('hidden')) el.classList.add('hidden');
        }

        if (this.connected && this.game.player && !this.game.player.isDead) {
            this.emitTimer += deltaTime;
            if (this.emitTimer >= this.emitInterval) {
                this.emitTimer = 0;
                const p = this.game.player;
                const moved = p.velocity.lengthSq() > 0.001;
                const rotated = Math.abs(p.rotation.y - (p.lastSentRotation || 0)) > 0.01;
                const healthChanged = p.health !== (p.lastSentHealth || 100);
                if (moved || rotated || healthChanged) {
                    p.lastSentRotation = p.rotation.y;
                    p.lastSentHealth = p.health;
                    this.socket.emit('playerMovement', {
                        x: p.position.x, y: p.position.y, z: p.position.z,
                        rotation: p.rotation.y, health: p.health,
                        team: this.myTeam
                    });
                }
            }
            this.pingTimer += deltaTime;
            if (this.pingTimer >= 2) {
                this.pingTimer = 0;

                // Heartbeat: Send status even if stationary (prevents AFK ghosts)
                const p = this.game.player;
                this.socket.emit('playerMovement', {
                    x: p.position.x, y: p.position.y, z: p.position.z,
                    rotation: p.rotation.y, health: p.health, ping: this.latency,
                    team: this.myTeam // IMPORTANT: Send team with every update to stay synced
                });

                this.lastPingTime = Date.now();
                this.socket.emit('ping');
            }
        }
    }
}

// ==================== REMOTE PLAYER ====================
// Shared geometries (created once, reused by all players)
let sharedGeometries = null;
function getSharedGeometries() {
    if (!sharedGeometries) {
        sharedGeometries = {
            bodyGeom: new THREE.BoxGeometry(0.9, 1.6, 0.6),
            headGeom: new THREE.SphereGeometry(0.3, 8, 8),
            gunBodyGeom: new THREE.BoxGeometry(0.1, 0.15, 0.4),
            gunBarrelGeom: new THREE.BoxGeometry(0.04, 0.04, 0.4),
            gunMagGeom: new THREE.BoxGeometry(0.06, 0.15, 0.08),
            flashGeom: new THREE.ConeGeometry(0.12, 0.25, 8),
            healthBgGeom: new THREE.PlaneGeometry(1, 0.1),
            healthFillGeom: new THREE.PlaneGeometry(1, 0.1),
            torsoGeom: new THREE.BoxGeometry(0.4, 0.65, 0.25),
            vestGeom: new THREE.BoxGeometry(0.44, 0.5, 0.28),
            pouchGeom: new THREE.BoxGeometry(0.12, 0.15, 0.05),
            strapGeom: new THREE.BoxGeometry(0.1, 0.25, 0.29),
            headBoxGeom: new THREE.BoxGeometry(0.35, 0.35, 0.35),
            beardGeom: new THREE.BoxGeometry(0.36, 0.2, 0.15),
            shemaghTopGeom: new THREE.BoxGeometry(0.38, 0.12, 0.38),
            shemaghBackGeom: new THREE.BoxGeometry(0.3, 0.5, 0.1),
            armGeom: new THREE.BoxGeometry(0.15, 0.65, 0.15),
            legGeom: new THREE.BoxGeometry(0.2, 0.65, 0.2),
            bootGeom: new THREE.BoxGeometry(0.22, 0.2, 0.3),
            healthBarGeom: new THREE.PlaneGeometry(0.8, 0.1),
            shieldGeom: new THREE.SphereGeometry(1.2, 12, 12)
        };
    }
    return sharedGeometries;
}

class RemotePlayer {
    constructor(game, info, sharedMaterials) {
        this.game = game;
        this.id = info.id;
        this.sharedMaterials = sharedMaterials;

        // Current visual state
        this.position = new THREE.Vector3(info.x, info.y, info.z);
        this.rotation = info.rotation;

        // Target state for interpolation
        this.targetPosition = this.position.clone();
        this.targetRotation = this.rotation;

        // Track if position has changed (optimization)
        this.needsUpdate = true;
        this.billboardTimer = Math.random() * 0.2;
        this.deathFaded = false;

        this.mesh = null;
        this.nameTagTexture = null; // Track for cleanup
        this.spawnProtected = info.spawnProtected || false;
        this.createMesh(info);
    }

    createMesh(info) {
        this.team = info.team;

        this.mesh = new THREE.Group();
        this.mesh.userData = { type: 'remotePlayer', id: this.id, isMoving: true };
        const isMe = this.id === this.game.networkManager?.playerId;

        // VISUAL OFFSET: Shift everything down so feet touch the ground
        const visualGroup = new THREE.Group();
        visualGroup.position.set(0, -1.7, 0);
        visualGroup.rotation.y = Math.PI;
        this.mesh.add(visualGroup);

        const teamRed = 0xff3333;
        const teamBlue = 0x3366ff;
        const teamGray = 0x888888; // Neutral

        let teamColor = teamGray;
        let pantsColor = 0x444444;

        if (this.team === 'red') {
            teamColor = teamRed;
            pantsColor = 0x662222;
        } else if (this.team === 'blue') {
            teamColor = teamBlue;
            pantsColor = 0x222266;
        } else if (this.team === 'ffa') {
            // Randomize FFA colors
            const ffaColors = [
                { shirt: 0xff6b6b, pants: 0x660000 }, // Red
                { shirt: 0x6bffff, pants: 0x006666 }, // Cyan
                { shirt: 0xffff6b, pants: 0x666600 }, // Yellow
                { shirt: 0xff6bff, pants: 0x660066 }, // Magenta
                { shirt: 0x6bff6b, pants: 0x006600 }, // Lime
                { shirt: 0xffaa6b, pants: 0x663300 }  // Orange
            ];
            const randomFFA = ffaColors[Math.floor(Math.random() * ffaColors.length)];
            teamColor = randomFFA.shirt;
            pantsColor = randomFFA.pants;
        }

        const colors = {
            skin: 0xcc9977,
            beard: 0x1a1a1a,
            shemagh: 0x222222,
            shirt: 0x8b7d6b, // Camo/Tan base
            vest: 0x3d4a36,  // Olive tactical vest
            pants: 0x2d2d2d, // Dark grey combat pants
            leather: 0x1a1a1a,
            boots: 0x221105
        };

        const m = {
            s: new THREE.MeshStandardMaterial({ color: colors.skin, roughness: 0.72, metalness: 0.02 }),
            b: new THREE.MeshStandardMaterial({ color: colors.beard, roughness: 0.9, metalness: 0.0 }),
            shm: new THREE.MeshStandardMaterial({ color: colors.shemagh, roughness: 0.86, metalness: 0.0 }),
            sh: new THREE.MeshStandardMaterial({ color: colors.shirt, roughness: 0.82, metalness: 0.03 }),
            v: new THREE.MeshStandardMaterial({ color: colors.vest, roughness: 0.68, metalness: 0.08 }),
            p: new THREE.MeshStandardMaterial({ color: colors.pants, roughness: 0.8, metalness: 0.04 }),
            l: new THREE.MeshStandardMaterial({ color: colors.leather, roughness: 0.42, metalness: 0.02 }),
            bt: new THREE.MeshStandardMaterial({ color: colors.boots, roughness: 0.48, metalness: 0.04 })
        };
        const geoms = getSharedGeometries();

        // Helper to tag all parts for hit detection
        const tag = (mesh, isHead = false) => {
            mesh.userData = { type: 'remotePlayer', id: this.id, isHead: isHead };
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            return mesh;
        };

        // --- TORSO (Shirt) ---
        const torso = tag(new THREE.Mesh(geoms.torsoGeom, m.sh));
        torso.position.y = 1.05;
        visualGroup.add(torso);

        // --- TACTICAL VEST ---
        const vest = tag(new THREE.Mesh(geoms.vestGeom, m.v));
        vest.position.y = 0.05;
        torso.add(vest);

        // Vest Pouches
        const pouch1 = tag(new THREE.Mesh(geoms.pouchGeom, m.v));
        pouch1.position.set(-0.1, -0.05, 0.15); vest.add(pouch1);
        const pouch2 = tag(new THREE.Mesh(geoms.pouchGeom, m.v));
        pouch2.position.set(0.1, -0.05, 0.15); vest.add(pouch2);

        // Shoulder Straps
        const strapL = tag(new THREE.Mesh(geoms.strapGeom, m.v));
        strapL.position.set(-0.15, 0.35, 0); torso.add(strapL);
        const strapR = tag(new THREE.Mesh(geoms.strapGeom, m.v));
        strapR.position.set(0.15, 0.35, 0); torso.add(strapR);

        // --- HEAD ---
        const hG = new THREE.Group(); hG.position.y = 1.6; visualGroup.add(hG);
        const head = tag(new THREE.Mesh(geoms.headBoxGeom, m.s), true);
        hG.add(head);

        // Beard
        const beard = tag(new THREE.Mesh(geoms.beardGeom, m.b));
        beard.position.set(0, -0.1, 0.12); head.add(beard);

        // Shemagh (Headscarf)
        const shemaghTop = tag(new THREE.Mesh(geoms.shemaghTopGeom, m.shm));
        shemaghTop.position.y = 0.15; head.add(shemaghTop);

        const shemaghBack = tag(new THREE.Mesh(geoms.shemaghBackGeom, m.shm));
        shemaghBack.position.set(0.1, -0.15, -0.16);
        shemaghBack.rotation.z = 0.1;
        head.add(shemaghBack); // The trailing part seen in image

        // --- ARMS ---
        const aL = tag(new THREE.Mesh(geoms.armGeom, m.sh));
        aL.position.set(-0.35, 1.25, 0); aL.rotation.x = -0.2; visualGroup.add(aL);
        const aR = tag(new THREE.Mesh(geoms.armGeom, m.sh));
        aR.position.set(0.35, 1.25, 0); aR.rotation.x = -0.8; visualGroup.add(aR);

        // --- LEGS ---
        const lL = tag(new THREE.Mesh(geoms.legGeom, m.p));
        lL.position.set(-0.12, 0.35, 0); visualGroup.add(lL);
        const lR = tag(new THREE.Mesh(geoms.legGeom, m.p));
        lR.position.set(0.12, 0.35, 0); visualGroup.add(lR);

        // COMBAT BOOTS
        const bootL = tag(new THREE.Mesh(geoms.bootGeom, m.bt));
        bootL.position.y = -0.3; lL.add(bootL);
        const bootR = tag(new THREE.Mesh(geoms.bootGeom, m.bt));
        bootR.position.y = -0.3; lR.add(bootR);

        // Weapon Group - Positioned in the hand
        const gunG = new THREE.Group();
        gunG.position.set(0.4, 0.9, -0.4); // Positioned relative to raised right arm
        gunG.rotation.x = 0; // Pointing forward
        visualGroup.add(gunG);

        const gMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.35, metalness: 0.75 });
        const gB = new THREE.Mesh(geoms.gunBodyGeom, gMat);
        gunG.add(gB);
        const gBar = new THREE.Mesh(geoms.gunBarrelGeom, gMat);
        gBar.position.set(0, 0.05, 0.35);
        gunG.add(gBar);

        this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
        this.muzzleFlash = new THREE.Mesh(geoms.flashGeom, this.flashMat);
        this.muzzleFlash.rotation.x = Math.PI / 2; this.muzzleFlash.position.set(0, 0.1, 0.8); gunG.add(this.muzzleFlash);
        this.flashLight = new THREE.PointLight(0xffaa44, 0, 3.5, 2);
        this.flashLight.position.copy(this.muzzleFlash.position);
        gunG.add(this.flashLight);

        this.mesh.position.copy(this.position);

        this.healthBg = new THREE.Mesh(geoms.healthBarGeom, new THREE.MeshBasicMaterial({ color: 0x000000 }));
        this.healthBg.position.y = 2.4 - 1.7; visualGroup.add(this.healthBg);

        // UI Colors
        let uiColorHex = '#888888';
        let uiColorObj = 0x888888;
        let uiBg = 'rgba(50,50,50,0.7)';

        if (this.team === 'red') {
            uiColorHex = '#ff3333'; uiColorObj = 0xff3333; uiBg = 'rgba(100,0,0,0.7)';
        } else if (this.team === 'blue') {
            uiColorHex = '#3366ff'; uiColorObj = 0x3366ff; uiBg = 'rgba(0,0,100,0.7)';
        }

        this.healthFillMat = new THREE.MeshBasicMaterial({ color: uiColorObj });
        this.healthFill = new THREE.Mesh(geoms.healthBarGeom, this.healthFillMat);
        this.healthFill.position.z = 0.01; this.healthBg.add(this.healthFill);

        const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
        canvas.width = 128; canvas.height = 32;
        ctx.fillStyle = isMe ? 'rgba(0,0,0,0.5)' : uiBg;
        ctx.fillRect(0, 0, 128, 32);
        ctx.fillStyle = isMe ? 'white' : uiColorHex; ctx.font = 'bold 20px Arial'; ctx.textAlign = 'center';
        ctx.fillText(isMe ? 'YOU' : (info.name || 'ENEMY'), 64, 24);

        this.nameTagTexture = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.nameTagTexture }));
        sprite.position.y = 2.7; sprite.scale.set(1.5, 0.375, 1);
        this.nameTag = sprite; this.mesh.add(sprite);

        // Spawn Protection Shield
        this.shieldMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.3, wireframe: true });
        this.shieldMesh = new THREE.Mesh(geoms.shieldGeom, this.shieldMat);
        this.shieldMesh.position.y = 1;
        this.shieldMesh.visible = false;
        this.mesh.add(this.shieldMesh);

        this.game.renderer.addToScene(this.mesh);
    }

    updatePosition(info) {
        // Team Change Detection
        if (this.team !== info.team) {
            debugLog(`[TEAM SYNC] Player ${this.id} changed to ${info.team}`);
            this.team = info.team;
            this.destroy(); // Remove old color mesh
            this.createMesh(info); // Create new color mesh
            this.isDestroying = false; // Reset flag so update() works again
        }

        // Update targets, don't snap immediately
        const newTarget = new THREE.Vector3(info.x, info.y, info.z);

        // Only mark as needing update if position actually changed
        if (newTarget.distanceToSquared(this.targetPosition) > 0.0001 ||
            Math.abs(info.rotation - this.targetRotation) > 0.01 ||
            this.health !== info.health) {
            this.needsUpdate = true;
        }

        this.targetPosition.copy(newTarget);
        this.targetRotation = info.rotation;
        this.health = info.health;
        this.spawnProtected = info.spawnProtected || false;
    }

    visualShoot() {
        try {
            if (this.flashMat && !this.isDestroying) {
                this.flashMat.opacity = 1;
            }
            if (this.flashLight && !this.isDestroying) {
                this.flashLight.intensity = 2.8;
            }
            if (this.mesh && this.game.audioManager && this.game.player) {
                this.game.audioManager.play3DSound('shoot', this.mesh.position, this.game.player.position, 0.3);
            }
        } catch (e) {
            // Ignore errors during destruction
        }
    }

    destroy() {
        this.isDestroying = true;

        if (this.mesh) {
            // Mark mesh as destroying so raycasts skip it
            this.mesh.userData.destroying = true;

            try {
                this.game.renderer.removeFromScene(this.mesh);

                // Dispose individual materials (not shared ones)
                if (this.flashMat) this.flashMat.dispose();
                if (this.healthFillMat) this.healthFillMat.dispose();
                if (this.nameTagTexture) this.nameTagTexture.dispose();
                if (this.nameTag && this.nameTag.material) this.nameTag.material.dispose();
                if (this.shieldMat) this.shieldMat.dispose();
            } catch (e) {
                console.warn('Error disposing remote player:', e.message);
            }
        }
        this.mesh = null;
        this.flashMat = null;
        this.healthFillMat = null;
        this.nameTagTexture = null;
    }

    update(deltaTime) {
        if (!this.mesh || this.isDestroying) return;

        try {
            // Visual Death Handling
            if (this.health <= 0) {
                if (this.mesh.rotation.x < Math.PI / 2) {
                    this.mesh.rotation.x += deltaTime * 5;
                    this.mesh.position.y -= deltaTime * 3;
                }
                if (this.healthFill) this.healthFill.visible = false;
                if (!this.deathFaded) {
                    this.mesh.traverse(child => { if (child.material) { child.material.opacity = 0.3; child.material.transparent = true; } });
                    this.deathFaded = true;
                }
                return;
            } else {
                // Reset visuals if alive
                if (this.mesh.rotation.x > 0) {
                    this.mesh.rotation.x = 0;
                    this.mesh.position.y = this.position.y;
                    if (this.healthFill) this.healthFill.visible = true;
                    this.mesh.traverse(child => { if (child.material) child.material.opacity = 1; });
                    this.deathFaded = false;
                }
            }

            // Only do expensive updates if position changed
            if (this.needsUpdate) {
                // Smoothly interpolate position
                this.position.lerp(this.targetPosition, deltaTime * 10);
                this.mesh.position.copy(this.position);

                // Smoothly interpolate rotation
                let diff = this.targetRotation - this.rotation;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;

                this.rotation += diff * deltaTime * 10;
                this.mesh.rotation.y = this.rotation;

                // Check if we're close enough to target to stop updating
                if (this.position.distanceToSquared(this.targetPosition) < 0.0001 &&
                    Math.abs(diff) < 0.01) {
                    this.needsUpdate = false;
                }
            }

            // Update Health Bar (always update for billboarding)
            if (this.healthFill && this.healthFillMat) {
                const healthPct = Math.max(0, (this.health || 100) / 100);
                this.healthFill.scale.x = healthPct;
                this.healthFill.position.x = (healthPct - 1) * 0.5;
                this.healthFillMat.color.setHSL(healthPct * 0.3, 1, 0.5);

                this.billboardTimer -= deltaTime;
                if (this.billboardTimer <= 0) {
                    this.billboardTimer = 0.15;
                    const camera = this.game.renderer.camera;
                    if (this.healthBg) this.healthBg.lookAt(camera.position);
                }
            }

            // Fade muzzle flash
            if (this.flashMat && this.flashMat.opacity > 0) {
                this.flashMat.opacity -= deltaTime * 10;
            }
            if (this.flashLight && this.flashLight.intensity > 0) {
                this.flashLight.intensity = Math.max(0, this.flashLight.intensity - deltaTime * 40);
            }

            // Shield Visual
            if (this.shieldMesh) {
                const isProtected = this.spawnProtected;
                this.shieldMesh.visible = isProtected;
                if (isProtected) {
                    this.shieldMesh.rotation.y += deltaTime * 2; // Rotate effect
                    this.shieldMat.opacity = 0.3 + Math.sin(Date.now() * 0.01) * 0.1; // Pulse effect
                }
            }
        } catch (e) {
            // Silently ignore update errors to prevent frame crashes
        }
    }
}

// ==================== GAME ENGINE ====================
class GameEngine {
    constructor() {
        this.isRunning = false;
        this.isPaused = false;
        this.gameState = 'menu';
        this.score = 0;
        this.kills = 0;
        this.startTime = 0;
        this.settings = {
            sensitivity: 0.5,
            volume: 0.7,
            showFps: true,
            showMinimap: true,
            crosshairColor: 'green',
            allowNonSniperAds: false
        };
        this.settings.showTracers = false;
        this.lastTime = 0;
        this.deltaTime = 0;
        this.fps = 60;
        this.fpsUpdateTime = 0;
        this.frameCount = 0;
        this.projectiles = [];
        this.lowFpsSamples = 0;
        this.goodFpsSamples = 0;
    }

    async init() {
        try {
            debugLog('Initializing Tactical Strike...');

            // Check if THREE is loaded
            if (typeof THREE === 'undefined') {
                throw new Error('Three.js library not loaded. Check internet connection or script tags.');
            }

            this.updateLoadingProgress(10, 'Initializing renderer...');

            this.renderer = new Renderer(this);
            await this.renderer.init();

            this.updateLoadingProgress(30, 'Loading physics & audio...');
            this.physics = new PhysicsWorld(this);
            this.audioManager = new AudioManager(this);

            this.networkManager = new NetworkManager(this); // Init Network Manager

            this.updateLoadingProgress(50, 'Setting up UI & Input...');
            this.uiManager = new UIManager(this);
            this.uiManager.init();
            this.inputManager = new InputManager(this);

            this.updateLoadingProgress(70, 'Generate Level...');
            this.levelManager = new LevelManager(this);
            await this.levelManager.loadLevel();

            // this.enemyManager = new EnemyManager(this); // Disabled for PvP
            this.updateLoadingProgress(90, 'Creating entities...');
            this.player = new Player(this);

            // Connect to server
            this.updateLoadingProgress(95, 'Connecting to server...');
            this.networkManager.init();

            this.updateLoadingProgress(100, 'Ready!');

            setTimeout(() => {
                const loadingScreen = document.getElementById('loading-screen');
                if (loadingScreen) loadingScreen.classList.add('hidden');
            }, 500);

            debugLog('Game initialized!');
        } catch (error) {
            console.error('Game initialization failed:', error);
            const loadingText = document.getElementById('loading-text');
            if (loadingText) {
                loadingText.textContent = `Error: ${error.message}`;
                loadingText.style.color = '#ff4444';
            }
        }
    }

    // ... (rest of methods)




    updateLoadingProgress(pct, text) {
        const bar = document.getElementById('loading-progress');
        const txt = document.getElementById('loading-text');
        if (bar) bar.style.width = `${pct}%`;
        if (txt) txt.textContent = text;
    }

    showMainMenu() {
        this.gameState = 'menu';
        document.getElementById('main-menu')?.classList.remove('hidden');
        document.getElementById('game-hud')?.classList.add('hidden');
        document.getElementById('team-modal')?.classList.add('hidden');
        document.getElementById('team-choice-modal')?.classList.add('hidden');
        document.getElementById('pause-menu')?.classList.add('hidden');
        document.getElementById('death-screen')?.classList.add('hidden');
        document.getElementById('match-end-screen')?.classList.add('hidden');
        this.isPaused = true;
    }

    startGame() {
        debugLog('Starting game...');
        try {
            this.gameState = 'playing';
            this.isPaused = false;
            this.score = 0;
            this.kills = 0;
            this.startTime = Date.now();

            const menuIds = ['main-menu', 'pause-menu', 'death-screen', 'victory-screen', 'match-end-screen', 'team-modal', 'team-choice-modal', 'name-modal'];
            menuIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });

            // Ensure chat container is visible on all game start paths
            const chatContainer = document.getElementById('chat-container');
            if (chatContainer) chatContainer.classList.remove('hidden');
            document.getElementById('game-hud')?.classList.remove('hidden');

            // Hide enemy counter for PvP (safely)
            const enemyCount = document.getElementById('enemy-count');
            if (enemyCount) enemyCount.style.display = 'none';

            const objText = document.getElementById('objective-text');
            if (objText) objText.textContent = 'Defeat other players';

            if (this.player) this.player.reset();
            // this.enemyManager.spawnEnemies(); // Disabled for PvP

            // Re-request pointer lock
            if (this.renderer && this.renderer.canvas && !this.inputManager?.isMobile) {
                this.renderer.canvas.requestPointerLock();
            }

            if (!this.isRunning) {
                this.isRunning = true;
                this.lastTime = performance.now();
                this.gameLoop();
            }
        } catch (error) {
            console.error('Error starting game:', error);
            alert('Error starting game: ' + error.message);
        }
    }

    pauseGame() {
        if (this.gameState !== 'playing') return;
        this.gameState = 'paused';
        this.isPaused = true;
        document.getElementById('pause-menu')?.classList.remove('hidden');
        document.exitPointerLock();
    }

    resumeGame() {
        if (this.gameState !== 'paused') return;
        this.gameState = 'playing';
        this.isPaused = false;
        document.getElementById('pause-menu')?.classList.add('hidden');
        this.renderer?.canvas?.requestPointerLock();
    }

    restartGame() {
        document.getElementById('pause-menu')?.classList.add('hidden');
        document.getElementById('death-screen')?.classList.add('hidden');
        document.getElementById('victory-screen')?.classList.add('hidden');
        document.getElementById('match-end-screen')?.classList.add('hidden');
        this.startGame();
    }

    playerDied() {
        if (this.gameState === 'dead') return; // Prevent double-death crashes
        this.gameState = 'dead';
        this.isPaused = true;

        try {
            document.exitPointerLock();
        } catch (e) {
            console.warn('Pointer lock exit error:', e.message);
        }

        try {
            const time = Math.floor((Date.now() - this.startTime) / 1000);
            const killsEl = document.getElementById('death-kills');
            if (killsEl) killsEl.textContent = this.kills || 0;

            const timeEl = document.getElementById('death-time');
            if (timeEl) timeEl.textContent = `${Math.floor(time / 60)}:${(time % 60).toString().padStart(2, '0')}`;

            const scoreEl = document.getElementById('death-score');
            if (scoreEl) scoreEl.textContent = this.score || 0;

            const hud = document.getElementById('game-hud');
            if (hud) hud.classList.add('hidden');

            const deathScreen = document.getElementById('death-screen');
            if (deathScreen) deathScreen.classList.remove('hidden');
        } catch (e) {
            console.error('Death screen error:', e.message);
        }
    }

    victory() {
        this.gameState = 'victory';
        this.isPaused = true;
        document.exitPointerLock();

        const time = Math.floor((Date.now() - this.startTime) / 1000);
        const killsEl = document.getElementById('victory-kills');
        const timeEl = document.getElementById('victory-time');
        const scoreEl = document.getElementById('victory-score');
        if (killsEl) killsEl.textContent = this.kills;
        if (timeEl) timeEl.textContent = `${Math.floor(time / 60)}:${(time % 60).toString().padStart(2, '0')}`;
        if (scoreEl) scoreEl.textContent = this.score;

        document.getElementById('game-hud')?.classList.add('hidden');
        document.getElementById('victory-screen')?.classList.remove('hidden');
    }

    addScore(points) { this.score += points; this.uiManager.updateScore(this.score); }

    addKill(type) {
        this.kills++;
        this.addScore(type === 'heavy' ? 200 : 100);
        this.uiManager.addKillFeed(`Eliminated ${type} enemy`);
        // if (this.enemyManager.getRemainingEnemies() === 0) setTimeout(() => this.victory(), 1000);
    }

    gameLoop(currentTime = performance.now()) {
        if (!this.isRunning) return;

        try {
            this.deltaTime = (currentTime - this.lastTime) / 1000;
            this.lastTime = currentTime;
            if (this.deltaTime > 0.1) this.deltaTime = 0.1;

            this.frameCount++;
            this.fpsUpdateTime += this.deltaTime;
            if (this.fpsUpdateTime >= 0.5) {
                this.fps = Math.round(this.frameCount / this.fpsUpdateTime);
                this.frameCount = 0;
                this.fpsUpdateTime = 0;
                const fpsCounter = document.getElementById('fps-counter');
                if (fpsCounter && this.settings.showFps) fpsCounter.textContent = `FPS: ${this.fps}`;
                this.updatePerformanceMode();
            }

            if (!this.isPaused && (this.gameState === 'playing' || this.gameState === 'menu')) {
                if (this.player && typeof this.player.update === 'function') {
                    this.player.update(this.deltaTime);
                }
                if (this.networkManager && typeof this.networkManager.update === 'function') {
                    this.networkManager.update(this.deltaTime);
                }
                if (this.uiManager && typeof this.uiManager.update === 'function') {
                    this.uiManager.update(this.deltaTime);
                    // HUD Sync Fallback every 60 frames
                    if (this.frameCount % 60 === 0) {
                        this.uiManager.updateHealth(this.player.health, this.player.maxHealth);
                        this.player.updateAmmoUI();
                    }
                }
                if (this.renderer && typeof this.renderer.updateImpacts === 'function') {
                    this.renderer.updateImpacts(this.deltaTime);
                }
                if (this.physics && typeof this.physics.update === 'function') {
                    this.physics.update(this.deltaTime);
                }
                // if (this.enemyManager) this.enemyManager.update(this.deltaTime); // Disabled for PvP

                // Update projectiles
                if (this.projectiles) {
                    for (let i = this.projectiles.length - 1; i >= 0; i--) {
                        const p = this.projectiles[i];
                        p.update(this.deltaTime);
                        if (!p.alive) this.projectiles.splice(i, 1);
                    }
                }
            }

            if (this.renderer) {
                this.renderer.render();
            }

            requestAnimationFrame((t) => this.gameLoop(t));
        } catch (error) {
            console.error('CRITICAL: Game Loop Error:', error);
            // Only alert once to prevent alert spam
            if (!this.alerted) {
                alert('Fatal Game Loop Error: ' + error.message + '\nCheck console for details.');
                this.alerted = true;
            }
            this.isRunning = false;
        }
    }

    updatePerformanceMode() {
        if (!this.renderer) return;

        if (this.fps > 0 && this.fps < 45) {
            this.lowFpsSamples++;
            this.goodFpsSamples = 0;
        } else if (this.fps > 58) {
            this.goodFpsSamples++;
            this.lowFpsSamples = 0;
        }

        if (this.lowFpsSamples >= 3) {
            this.renderer.setPerformanceMode(true);
        } else if (this.goodFpsSamples >= 8) {
            this.renderer.setPerformanceMode(false);
        }
    }
}

// ==================== INITIALIZE ====================
document.addEventListener('DOMContentLoaded', () => {
    const game = new GameEngine();
    window.game = game;

    // Initialize game first
    game.init().then(() => {
        // After game loads, show name modal
        const nameModal = document.getElementById('name-modal');
        const nameInput = document.getElementById('player-name-input');
        const confirmBtn = document.getElementById('btn-confirm-name');
        const mainMenu = document.getElementById('main-menu');

        const savedName = localStorage.getItem('playerName') || '';

        if (nameInput && confirmBtn && nameModal) {
            nameInput.value = savedName;
            nameModal.classList.remove('hidden');

            const gameModal = document.getElementById('team-modal');
            const teamChoiceModal = document.getElementById('team-choice-modal');
            const btnGameTdm = document.getElementById('btn-game-tdm');
            const btnGameFfa = document.getElementById('btn-game-ffa');
            const btnRed = document.getElementById('btn-team-red');
            const btnBlue = document.getElementById('btn-team-blue');

            const applyScoreMode = (showTeamScores) => {
                const scoreRed = document.getElementById('score-red');
                const scoreBlue = document.getElementById('score-blue');
                if (scoreRed) scoreRed.style.display = showTeamScores ? 'block' : 'none';
                if (scoreBlue) scoreBlue.style.display = showTeamScores ? 'block' : 'none';
            };

            const beginSelectedGame = (team, showTeamScores) => {
                gameModal?.classList.add('hidden');
                teamChoiceModal?.classList.add('hidden');
                if (mainMenu) mainMenu.classList.add('hidden');
                if (game.networkManager) {
                    game.networkManager.myTeam = team;
                    if (game.networkManager.socket) {
                        game.networkManager.socket.emit('setTeam', team);
                    }
                }

                game.startGame();
                document.getElementById('game-hud')?.classList.remove('hidden');
                applyScoreMode(showTeamScores);
            };

            const selectTeam = (team) => {
                beginSelectedGame(team, true);
            };

            const selectGameMode = (mode) => {
                if (mode === 'tdm') {
                    // Team Deathmatch - show team selection
                    gameModal?.classList.add('hidden');
                    teamChoiceModal?.classList.remove('hidden');
                } else if (mode === 'ffa') {
                    beginSelectedGame('ffa', false);
                }
            };

            const btnStart = document.getElementById('btn-start');
            const btnSettings = document.getElementById('btn-settings');
            const btnControls = document.getElementById('btn-controls');
            const btnQuit = document.getElementById('btn-quit');

            const settingsPanel = document.getElementById('settings-panel');
            const controlsPanel = document.getElementById('controls-panel');
            const btnSettingsBack = document.getElementById('btn-settings-back');
            const btnControlsBack = document.getElementById('btn-controls-back');

            const confirmName = () => {
                const name = String(nameInput.value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>]/g, '').trim().substring(0, 16) || 'Player';
                nameInput.value = name;
                localStorage.setItem('playerName', name);
                nameModal.classList.add('hidden');
                document.exitPointerLock(); // Ensure cursor is free

                // Show MAIN MENU after name
                if (mainMenu) mainMenu.classList.remove('hidden');

                if (game.networkManager) {
                    game.networkManager.setPlayerName(name);
                }
            };

            confirmBtn.addEventListener('click', confirmName);
            nameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') confirmName();
            });

            // Main Menu Buttons
            if (btnStart) {
                btnStart.addEventListener('click', () => {
                    document.exitPointerLock(); // Ensure cursor is visible for mode selection
                    mainMenu?.classList.add('hidden');
                    if (gameModal) gameModal.classList.remove('hidden');
                });
            }

            if (btnSettings) {
                btnSettings.addEventListener('click', () => {
                    mainMenu?.classList.add('hidden');
                    if (settingsPanel) settingsPanel.classList.remove('hidden');
                });
            }

            if (btnControls) {
                btnControls.addEventListener('click', () => {
                    mainMenu?.classList.add('hidden');
                    if (controlsPanel) controlsPanel.classList.remove('hidden');
                });
            }

            if (btnQuit) {
                btnQuit.addEventListener('click', () => {
                    window.close(); // May not work in all browsers
                    location.reload(); // Fallback
                });
            }

            // Back Buttons
            if (btnSettingsBack) {
                btnSettingsBack.addEventListener('click', () => {
                    settingsPanel?.classList.add('hidden');
                    mainMenu?.classList.remove('hidden');
                });
            }

            if (btnControlsBack) {
                btnControlsBack.addEventListener('click', () => {
                    controlsPanel?.classList.add('hidden');
                    mainMenu?.classList.remove('hidden');
                });
            }

            if (btnGameTdm) btnGameTdm.addEventListener('click', () => selectGameMode('tdm'));
            if (btnGameFfa) btnGameFfa.addEventListener('click', () => selectGameMode('ffa'));
            if (btnRed) btnRed.addEventListener('click', () => selectTeam('red'));
            if (btnBlue) btnBlue.addEventListener('click', () => selectTeam('blue'));

            // Focus the input
            setTimeout(() => nameInput.focus(), 100);
        } else {
            // No name modal - just show main menu
            if (mainMenu) mainMenu.classList.remove('hidden');
        }
    }).catch(err => {
        console.error('Failed to initialize game:', err);
    });

    // Chat input handling
    const chatContainer = document.getElementById('chat-container');
    const chatInputContainer = document.getElementById('chat-input-container');
    const chatInput = document.getElementById('chat-input');
    let chatOpen = false;

    document.addEventListener('keydown', (e) => {
        // Open chat with Enter (when not already open)
        if (e.key === 'Enter' && game.gameState === 'playing' && !chatOpen) {
            e.preventDefault();
            chatOpen = true;
            chatContainer?.classList.remove('hidden');
            chatInputContainer?.classList.remove('hidden');
            chatInput?.focus();
            document.exitPointerLock();
        }
        // Send message with Enter (when chat is open)
        else if (e.key === 'Enter' && chatOpen && chatInput) {
            e.preventDefault();
            const msg = chatInput.value.trim();
            if (msg && game.networkManager) {
                game.networkManager.sendChatMessage(msg);
            }
            chatInput.value = '';
            chatOpen = false;
            chatInputContainer?.classList.add('hidden');
            if (game.gameState === 'playing') {
                game.renderer?.canvas?.requestPointerLock();
            }
        }
        // Close chat with Escape
        else if (e.key === 'Escape' && chatOpen) {
            chatOpen = false;
            chatInput.value = '';
            chatInputContainer?.classList.add('hidden');
            if (game.gameState === 'playing') {
                game.renderer?.canvas?.requestPointerLock();
            }
        }
    });

    // NOTE: crosshair-color and show-minimap listeners are already registered
    // in UIManager.setupSettingsListeners(). Removed duplicates here to prevent
    // double-firing.

    // Settings name sync
    const settingsName = document.getElementById('settings-name');
    if (settingsName) {
        const currentName = localStorage.getItem('playerName') || 'Player';
        settingsName.value = currentName;
        settingsName.addEventListener('change', (e) => {
            const name = String(e.target.value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>]/g, '').trim().substring(0, 16) || 'Player';
            e.target.value = name;
            localStorage.setItem('playerName', name);
            if (game.networkManager) {
                game.networkManager.setPlayerName(name);
            }
        });
    }

    // Minimap render (basic)
    const drawMinimap = () => {
        if (!game.settings.showMinimap) return;
        const container = document.getElementById('minimap-container');
        if (container?.classList.contains('hidden')) return;
        const canvas = document.getElementById('minimap');
        if (!canvas || !game.player) return;

        const ctx = canvas.getContext('2d');
        const size = 150;
        const scale = size / 200; // 200 units = full map

        ctx.fillStyle = 'rgba(0, 20, 40, 0.8)';
        ctx.fillRect(0, 0, size, size);

        // Draw player
        const px = (game.player.position.x + 100) * scale;
        const pz = (game.player.position.z + 100) * scale;

        ctx.fillStyle = game.networkManager?.myTeam === 'red' ? '#ff3333' : '#3366ff';
        ctx.beginPath();
        ctx.arc(px, pz, 4, 0, Math.PI * 2);
        ctx.fill();

        // Draw player direction
        const dir = game.player.rotation.y;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, pz);
        ctx.lineTo(px + Math.sin(dir) * 10, pz - Math.cos(dir) * 10);
        ctx.stroke();

        // Draw other players
        if (game.networkManager) {
            Object.values(game.networkManager.remotePlayers).forEach(rp => {
                if (!rp.position) return;
                const rx = (rp.position.x + 100) * scale;
                const rz = (rp.position.z + 100) * scale;
                // In FFA, all enemies are red. In TDM, color by team.
                const myTeam = game.networkManager?.myTeam;
                if (myTeam === 'ffa' || !myTeam) {
                    ctx.fillStyle = '#ff3333'; // All enemies red in FFA
                } else {
                    ctx.fillStyle = rp.team === myTeam ? '#00ff88' : '#ff3333'; // Allies green, enemies red
                }
                ctx.beginPath();
                ctx.arc(rx, rz, 3, 0, Math.PI * 2);
                ctx.fill();
            });
        }
    };

    // Update minimap periodically
    setInterval(drawMinimap, 250);

    // Chat container visibility is now handled inside startGame() directly.

    // Prevent context menu on game canvas (fixes right-click ADS showing browser menu)
    document.addEventListener('contextmenu', (e) => {
        if (game.gameState === 'playing') {
            e.preventDefault();
        }
    });
});
