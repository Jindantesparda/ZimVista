/* eslint-disable no-use-before-define, no-alert, no-void */
import {
    Asset,
    Color,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSplatResource,
    RESOLUTION_AUTO,
    Vec3,
    createGraphicsDevice
} from 'playcanvas';

import { MappedReadFileSystem, loadGSplatData, validateGSplatData } from './io';
import { PCApp } from './pc-app';

type LoadedEntity = Entity & { destroy?: () => void };

interface CollisionTriangle {
    id: number;
    a: Vec3;
    b: Vec3;
    c: Vec3;
    normal: Vec3;
    walkable: boolean;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
}

interface CollisionIndex {
    cellSize: number;
    blocking: Map<string, CollisionTriangle[]>;
    walkable: Map<string, CollisionTriangle[]>;
}

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
const loaderPanel = document.getElementById('loader-panel') as HTMLElement;
const splatInput = document.getElementById('splat-input') as HTMLInputElement;
const glbInput = document.getElementById('glb-input') as HTMLInputElement;
const loadFilesButton = document.getElementById('load-files') as HTMLButtonElement;
const lockPointerButton = document.getElementById('lock-pointer') as HTMLButtonElement;
const saveSpawnButton = document.getElementById('save-spawn') as HTMLButtonElement;
const goSpawnButton = document.getElementById('go-spawn') as HTMLButtonElement;
const clearSpawnButton = document.getElementById('clear-spawn') as HTMLButtonElement;
const registerSceneButton = document.getElementById('register-scene') as HTMLButtonElement;
const exitViewerButton = document.getElementById('exit-viewer') as HTMLButtonElement;
const leaveViewerButton = document.getElementById('leave-viewer') as HTMLButtonElement;
const showScenesButton = document.getElementById('show-scenes') as HTMLButtonElement;
const closeScenesButton = document.getElementById('close-scenes') as HTMLButtonElement;
const centerPanel = document.getElementById('center-panel') as HTMLElement;
const toggleGlbButton = document.getElementById('toggle-glb') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const uiRoot = document.getElementById('viewer-ui') as HTMLElement;

const setStatus = (message: string) => {
    statusEl.textContent = message;
};

interface SceneEntry {
    name: string;
    description?: string;
    splat: string;
    glb?: string;
    thumbnail?: string;
}

const customScenesStorageKey = 'supersplat.walkthrough.customScenes';
let customSceneManifest: SceneEntry[] = [];
let currentSceneCatalog: SceneEntry[] = [];
let activeSceneKey = '';

const sceneEntryKey = (scene: SceneEntry) => `${scene.splat}|${scene.glb ?? ''}`;

const defaultSceneManifest: SceneEntry[] = [
    {
        name: 'Kotofuri Front Room',
        description: 'Room capture with optional collision GLB.',
        splat: 'kotofuri-front-room.splat',
        glb: 'kotofuri-front-room.collision.splat.glb'
    }
];

const sceneList = document.getElementById('scene-list') as HTMLElement;

const hasSceneQueryParams = () => {
    const params = new URLSearchParams(window.location.search);
    return Boolean(
        params.get('splat') || params.get('ply') || params.get('load') ||
        params.get('glb') || params.get('model')
    );
};

const syncSceneControls = () => {
    const sceneLoaded = !!(activeSplatId || activeGlbId);
    registerSceneButton.disabled = !sceneLoaded;
    exitViewerButton.disabled = !sceneLoaded;
    leaveViewerButton.disabled = !sceneLoaded;
};

const getStoredScenes = (): SceneEntry[] => {
    try {
        const raw = window.localStorage.getItem(customScenesStorageKey);
        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.filter((entry): entry is SceneEntry => {
            return entry && typeof entry === 'object' && typeof entry.name === 'string' && typeof entry.splat === 'string';
        });
    } catch {
        return [];
    }
};

const setStoredScenes = (scenes: SceneEntry[]) => {
    try {
        window.localStorage.setItem(customScenesStorageKey, JSON.stringify(scenes));
    } catch {
        // ignore storage failures
    }
};

const getAppBaseUrl = () => {
    const baseElement = document.querySelector('base');
    const baseHref = baseElement?.getAttribute('href')?.trim();
    if (baseHref && !baseHref.includes('__BASE_HREF__')) {
        return new URL(baseHref, window.location.href).toString();
    }

    return document.baseURI || `${window.location.origin}/`;
};

const sceneBaseUrlObj = new URL(getAppBaseUrl());
const sceneBaseUrl = getAppBaseUrl();

const resolveSceneUrl = (path: string) => {
    return new URL(path, sceneBaseUrl).toString();
};

const resolveSceneAsset = (path: string) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
        return path;
    }

    if (path.startsWith('/')) {
        return resolveSceneUrl(path.slice(1));
    }

    if (path.startsWith('./')) {
        return resolveSceneUrl(path);
    }

    if (path.startsWith('scenes/')) {
        return resolveSceneUrl(`./${path}`);
    }

    return resolveSceneUrl(`./scenes/${path}`);
};

const isPersistableScenePath = (path: string) => {
    try {
        const url = new URL(path, sceneBaseUrl);
        if (url.origin !== sceneBaseUrlObj.origin) {
            return true;
        }

        const relativePath = url.pathname.startsWith(sceneBaseUrlObj.pathname) ?
            url.pathname.slice(sceneBaseUrlObj.pathname.length) :
            url.pathname.slice(1);

        return relativePath.startsWith('scenes/');
    } catch {
        return false;
    }
};

const getPersistableScenePath = (path: string) => {
    try {
        const url = new URL(path, sceneBaseUrl);
        if (url.origin !== sceneBaseUrlObj.origin) {
            return url.toString();
        }

        const relativePath = url.pathname.startsWith(sceneBaseUrlObj.pathname) ?
            url.pathname.slice(sceneBaseUrlObj.pathname.length) :
            url.pathname.slice(1);

        if (relativePath.startsWith('scenes/')) {
            return relativePath.slice('scenes/'.length);
        }

        return relativePath;
    } catch {
        return path;
    }
};

const isInteractiveTarget = (target: EventTarget | null) => {
    return target instanceof HTMLElement &&
        !!target.closest('button, input, label, select, textarea, a');
};

const extensionOf = (name: string) => name.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';

const graphicsDevice = await createGraphicsDevice(canvas, {
    deviceTypes: ['webgl2'],
    antialias: true,
    depth: true,
    stencil: false,
    xrCompatible: false,
    powerPreference: 'high-performance'
});

const app = new PCApp(canvas, { graphicsDevice });
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, 2);
app.scene.clusteredLightingEnabled = false;

const camera = new Entity('walkthrough-camera');
camera.addComponent('camera', {
    clearColor: new Color(0.92, 0.93, 0.96),
    fov: 72,
    nearClip: 0.04,
    farClip: 2000
});
camera.setPosition(0, 1.65, 4);
app.root.addChild(camera);

const light = new Entity('walkthrough-light');
light.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.96, 0.9),
    intensity: 1.2
});
light.setEulerAngles(45, 35, 0);
app.root.addChild(light);

let splatEntity: LoadedEntity | null = null;
let glbEntity: LoadedEntity | null = null;
let yaw = 0;
let pitch = 0;
let moveSpeed = 2.4;
let verticalVelocity = 0;
let grounded = false;
let flyMode = true;
let collisionTriangles: CollisionTriangle[] = [];
let collisionIndex: CollisionIndex | null = null;
let fallbackGroundY: number | null = null;
let activeSplatId = '';
let activeGlbId = '';
let glbVisible = true;

interface SpawnPose {
    px: number;
    py: number;
    pz: number;
    yaw: number;
    pitch: number;
}

const pressed = new Set<string>();
const tempPosition = new Vec3();
const scratchA = new Vec3();
const scratchB = new Vec3();
const scratchC = new Vec3();
const scratchD = new Vec3();
const scratchE = new Vec3();
const sampleLow = new Vec3();
const sampleMid = new Vec3();
const sampleHigh = new Vec3();

const playerHeight = 1.65;
const playerRadius = 0.28;
const maxStepHeight = 0.38;
const gravity = -9.8;
const jumpSpeed = 4.3;
const walkableNormalY = 0.6;
const groundSnapDistance = 0.22;
const groundSampleRadius = playerRadius * 0.7;
const groundBlendTolerance = 0.12;
const collisionSkin = 0.06;
const collisionCellSize = 2.5;

const destroyEntity = (entity: LoadedEntity | null) => {
    if (entity) {
        entity.destroy();
    }
};

const cellKey = (x: number, z: number) => `${x},${z}`;

const getIndexBucket = (
    map: Map<string, CollisionTriangle[]>,
    x: number,
    z: number
) => {
    const key = cellKey(x, z);
    let bucket = map.get(key);
    if (!bucket) {
        bucket = [];
        map.set(key, bucket);
    }
    return bucket;
};

const buildCollisionIndex = (triangles: CollisionTriangle[]): CollisionIndex => {
    const index: CollisionIndex = {
        cellSize: collisionCellSize,
        blocking: new Map(),
        walkable: new Map()
    };

    for (const tri of triangles) {
        const minCellX = Math.floor(tri.minX / index.cellSize);
        const maxCellX = Math.floor(tri.maxX / index.cellSize);
        const minCellZ = Math.floor(tri.minZ / index.cellSize);
        const maxCellZ = Math.floor(tri.maxZ / index.cellSize);
        const map = tri.walkable ? index.walkable : index.blocking;

        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                getIndexBucket(map, cellX, cellZ).push(tri);
            }
        }
    }

    return index;
};

const getNearbyTriangles = (x: number, z: number, radius: number, walkable: boolean) => {
    if (!collisionIndex) {
        return collisionTriangles.filter(tri => tri.walkable === walkable);
    }

    const map = walkable ? collisionIndex.walkable : collisionIndex.blocking;
    const minCellX = Math.floor((x - radius) / collisionIndex.cellSize);
    const maxCellX = Math.floor((x + radius) / collisionIndex.cellSize);
    const minCellZ = Math.floor((z - radius) / collisionIndex.cellSize);
    const maxCellZ = Math.floor((z + radius) / collisionIndex.cellSize);
    const result: CollisionTriangle[] = [];
    const seen = new Set<number>();

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            const bucket = map.get(cellKey(cellX, cellZ));
            if (!bucket) {
                continue;
            }

            for (const tri of bucket) {
                if (!seen.has(tri.id)) {
                    seen.add(tri.id);
                    result.push(tri);
                }
            }
        }
    }

    return result;
};

const getSceneKey = () => {
    const id = activeSplatId || activeGlbId || 'default';
    return `supersplat.walkthrough.spawn.${id}`;
};

const getSpawnPose = (): SpawnPose | null => {
    try {
        const raw = window.localStorage.getItem(getSceneKey());
        return raw ? JSON.parse(raw) as SpawnPose : null;
    } catch {
        return null;
    }
};

const applySpawnPose = (pose: SpawnPose | null) => {
    if (!pose) {
        return false;
    }

    camera.setPosition(pose.px, pose.py, pose.pz);
    yaw = pose.yaw;
    pitch = pose.pitch;
    camera.setEulerAngles(pitch, yaw, 0);
    verticalVelocity = 0;
    grounded = false;
    return true;
};

const saveSpawnPose = () => {
    const position = camera.getPosition();
    const pose: SpawnPose = {
        px: position.x,
        py: position.y,
        pz: position.z,
        yaw,
        pitch
    };
    window.localStorage.setItem(getSceneKey(), JSON.stringify(pose));
    setStatus('Spawn point saved for this space.');
};

const clearSpawnPose = () => {
    window.localStorage.removeItem(getSceneKey());
    setStatus('Saved spawn point cleared for this space.');
};

const goToSpawnPose = () => {
    if (applySpawnPose(getSpawnPose())) {
        setStatus('Moved to saved spawn point.');
    } else {
        setStatus('No saved spawn point for this space yet.');
    }
};

const applySavedSpawnIfAny = () => {
    if (applySpawnPose(getSpawnPose())) {
        setStatus('Loaded saved spawn point for this space.');
        return true;
    }

    return false;
};

const syncGlbVisibilityButton = () => {
    toggleGlbButton.textContent = glbVisible ? 'Hide GLB' : 'Show GLB';
    toggleGlbButton.disabled = !glbEntity;
};

const setGlbVisible = (visible: boolean) => {
    glbVisible = visible;
    if (glbEntity) {
        glbEntity.enabled = glbVisible;
    }
    syncGlbVisibilityButton();
    setStatus(glbVisible ? 'GLB model visible.' : 'GLB model hidden. Physics remains active.');
};

const closestPointOnTriangle = (point: Vec3, a: Vec3, b: Vec3, c: Vec3, target: Vec3) => {
    const ab = scratchA.sub2(b, a);
    const ac = scratchB.sub2(c, a);
    const ap = scratchC.sub2(point, a);
    const d1 = ab.dot(ap);
    const d2 = ac.dot(ap);

    if (d1 <= 0 && d2 <= 0) {
        return target.copy(a);
    }

    const bp = scratchC.sub2(point, b);
    const d3 = ab.dot(bp);
    const d4 = ac.dot(bp);

    if (d3 >= 0 && d4 <= d3) {
        return target.copy(b);
    }

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return target.copy(ab).mulScalar(v).add(a);
    }

    const cp = scratchC.sub2(point, c);
    const d5 = ab.dot(cp);
    const d6 = ac.dot(cp);

    if (d6 >= 0 && d5 <= d6) {
        return target.copy(c);
    }

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return target.copy(ac).mulScalar(w).add(a);
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const bc = scratchD.sub2(c, b);
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return target.copy(bc).mulScalar(w).add(b);
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return target.copy(a).add(ab.mulScalar(v)).add(ac.mulScalar(w));
};

const rayTriangleY = (x: number, z: number, originY: number, tri: CollisionTriangle) => {
    const edge1 = scratchA.sub2(tri.b, tri.a);
    const edge2 = scratchB.sub2(tri.c, tri.a);
    const h = scratchC.set(-edge2.z, 0, edge2.x);
    const det = edge1.dot(h);

    if (Math.abs(det) < 0.000001) {
        return null;
    }

    const invDet = 1 / det;
    const s = scratchD.set(x - tri.a.x, originY - tri.a.y, z - tri.a.z);
    const u = invDet * s.dot(h);
    if (u < 0 || u > 1) {
        return null;
    }

    const q = scratchE.cross(s, edge1);
    const v = invDet * -q.y;
    if (v < 0 || u + v > 1) {
        return null;
    }

    const t = invDet * edge2.dot(q);
    return t >= 0 ? originY - t : null;
};

const findGroundYAtPoint = (sampleX: number, sampleZ: number, eye: Vec3) => {
    const footY = eye.y - playerHeight;
    const originY = eye.y + 0.1;
    let bestY = -Infinity;

    for (const tri of getNearbyTriangles(sampleX, sampleZ, playerRadius * 2, true)) {
        if (
            sampleX < tri.minX - playerRadius ||
            sampleX > tri.maxX + playerRadius ||
            sampleZ < tri.minZ - playerRadius ||
            sampleZ > tri.maxZ + playerRadius ||
            tri.maxY < footY - 1.2 ||
            tri.minY > eye.y + 0.2
        ) {
            continue;
        }

        const y = rayTriangleY(sampleX, sampleZ, originY, tri);
        if (y !== null && y <= footY + maxStepHeight && y > bestY) {
            bestY = y;
        }
    }

    return bestY !== -Infinity ? bestY : null;
};

const findGroundY = (eye: Vec3) => {
    const samples = [
        [0, 0],
        [groundSampleRadius, 0],
        [0, groundSampleRadius]
    ];

    const hits: number[] = [];
    let highest = -Infinity;

    for (const [offsetX, offsetZ] of samples) {
        const y = findGroundYAtPoint(eye.x + offsetX, eye.z + offsetZ, eye);
        if (y !== null) {
            hits.push(y);
            highest = Math.max(highest, y);
        }
    }

    if (hits.length > 0) {
        const stableHits = hits.filter(y => highest - y <= groundBlendTolerance);
        const total = stableHits.reduce((sum, y) => sum + y, 0);
        return total / stableHits.length;
    }

    const footY = eye.y - playerHeight;
    if (fallbackGroundY !== null && footY <= fallbackGroundY + maxStepHeight) {
        return fallbackGroundY;
    }

    return null;
};

const resolveCollisions = (eye: Vec3) => {
    const samples = [
        sampleLow.set(eye.x, eye.y - playerHeight + playerRadius, eye.z),
        sampleMid.set(eye.x, eye.y - playerHeight * 0.5, eye.z),
        sampleHigh.set(eye.x, eye.y - playerRadius, eye.z)
    ];
    const effectiveRadius = playerRadius - collisionSkin;

    for (let iteration = 0; iteration < 3; iteration++) {
        let moved = false;

        for (const tri of getNearbyTriangles(eye.x, eye.z, playerRadius * 3, false)) {
            if (
                eye.x < tri.minX - playerRadius ||
                eye.x > tri.maxX + playerRadius ||
                eye.y < tri.minY - playerRadius ||
                eye.y - playerHeight > tri.maxY + playerRadius ||
                eye.z < tri.minZ - playerRadius ||
                eye.z > tri.maxZ + playerRadius
            ) {
                continue;
            }

            for (const sample of samples) {
                const closest = closestPointOnTriangle(sample, tri.a, tri.b, tri.c, scratchD);
                const push = scratchE.sub2(sample, closest);
                const distance = push.length();

                if (distance > 0.0001 && distance < effectiveRadius) {
                    push.mulScalar((effectiveRadius - distance) / distance);
                    eye.add(push);
                    for (const s of samples) {
                        s.add(push);
                    }
                    moved = true;
                }
            }
        }

        if (!moved) {
            break;
        }
    }
};

const collectCollisionTriangles = (root: Entity) => {
    const triangles: CollisionTriangle[] = [];
    const renders = root.findComponents('render') as any[];
    let lowestY = Infinity;
    let nextId = 0;

    for (const render of renders) {
        const meshInstances = render.meshInstances ?? [];
        for (const meshInstance of meshInstances) {
            const aabb = meshInstance.aabb;
            if (aabb) {
                lowestY = Math.min(lowestY, aabb.getMin().y);
            }

            const mesh = meshInstance.mesh;
            if (!mesh) {
                continue;
            }

            const positions: number[] = [];
            const indices: number[] = [];
            const vertexCount = mesh.getPositions(positions);
            const indexCount = mesh.getIndices(indices);
            const transform = meshInstance.node.getWorldTransform();
            const useIndices = indexCount > 0;
            const count = useIndices ? indexCount : vertexCount;

            for (let i = 0; i + 2 < count; i += 3) {
                const ia = useIndices ? indices[i] : i;
                const ib = useIndices ? indices[i + 1] : i + 1;
                const ic = useIndices ? indices[i + 2] : i + 2;

                const a = new Vec3(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]);
                const b = new Vec3(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]);
                const c = new Vec3(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]);
                transform.transformPoint(a, a);
                transform.transformPoint(b, b);
                transform.transformPoint(c, c);
                const edgeAB = new Vec3().sub2(b, a);
                const edgeAC = new Vec3().sub2(c, a);
                const normal = new Vec3().cross(edgeAB, edgeAC).normalize();
                const walkable = normal.y >= walkableNormalY;

                triangles.push({
                    id: nextId++,
                    a,
                    b,
                    c,
                    normal,
                    walkable,
                    minX: Math.min(a.x, b.x, c.x),
                    maxX: Math.max(a.x, b.x, c.x),
                    minY: Math.min(a.y, b.y, c.y),
                    maxY: Math.max(a.y, b.y, c.y),
                    minZ: Math.min(a.z, b.z, c.z),
                    maxZ: Math.max(a.z, b.z, c.z)
                });
            }
        }
    }

    fallbackGroundY = lowestY === Infinity ? null : lowestY;
    collisionIndex = buildCollisionIndex(triangles);
    return triangles;
};

const addSplatData = (filename: string, gsplatData: any) => {
    validateGSplatData(gsplatData);

    destroyEntity(splatEntity);

    const asset = new Asset(filename, 'gsplat', {
        url: `walkthrough-splat-${Date.now()}`,
        filename
    });
    app.assets.add(asset);
    asset.resource = new GSplatResource(app.graphicsDevice, gsplatData);

    splatEntity = new Entity(filename);
    splatEntity.setEulerAngles(0, 0, 180);
    splatEntity.addComponent('gsplat', { asset });
    app.root.addChild(splatEntity);

    const aabb = (asset.resource as GSplatResource).aabb;
    if (aabb) {
        const center = aabb.center;
        const radius = Math.max(1, aabb.halfExtents.length());
        camera.setPosition(center.x, center.y + Math.min(1.7, radius * 0.35), center.z + radius * 1.4);
        yaw = 0;
        pitch = 0;
    }

    applySavedSpawnIfAny();
    syncSceneControls();
};

const loadSplatFromFile = async (file: File) => {
    activeSceneKey = '';
    renderSceneList(currentSceneCatalog);
    setStatus(`Loading ${file.name}...`);
    activeSplatId = file.name;
    const fs = new MappedReadFileSystem();
    fs.addFile(file.name, file);
    const gsplatData = await loadGSplatData(file.name, fs);
    addSplatData(file.name, gsplatData);
    setStatus(`Loaded ${file.name}. Load a GLB to enable physical walking collisions.`);
    loaderPanel.classList.add('is-hidden');
};

const loadSplatFromUrl = async (url: string) => {
    activeSceneKey = '';
    renderSceneList(currentSceneCatalog);
    const filename = new URL(url, window.location.href).toString();
    setStatus(`Loading ${url}...`);
    activeSplatId = url;
    const fs = new MappedReadFileSystem();
    const gsplatData = await loadGSplatData(filename, fs);
    addSplatData(url, gsplatData);
    setStatus(`Loaded ${url}. Load a GLB to enable physical walking collisions.`);
    loaderPanel.classList.add('is-hidden');
};

const loadGlbFromUrl = async (url: string, filename = url) => {
    destroyEntity(glbEntity);
    collisionTriangles = [];
    collisionIndex = null;
    fallbackGroundY = null;
    activeGlbId = filename;
    glbVisible = true;
    syncGlbVisibilityButton();
    setStatus(`Loading ${filename}...`);

    await new Promise<void>((resolve, reject) => {
        app.assets.loadFromUrlAndFilename(url, filename, 'container', (err: string | null, asset?: Asset) => {
            if (err || !asset) {
                reject(new Error(err ?? 'Failed to load GLB asset'));
                return;
            }

            const entity = (asset.resource as any).instantiateRenderEntity({
                castShadows: false,
                receiveShadows: false
            });
            glbEntity = entity;

            if (glbEntity) {
                glbEntity.enabled = glbVisible;
                app.root.addChild(glbEntity);
                collisionTriangles = collectCollisionTriangles(glbEntity);
                flyMode = collisionTriangles.length === 0 && fallbackGroundY === null;
                verticalVelocity = 0;
            }
            resolve();
        });
    });

    const physicsMessage = collisionTriangles.length > 0 ?
        `Physics ON: ${collisionTriangles.length.toLocaleString()} collision triangles.` :
        `No readable mesh triangles found. Floor fallback ${fallbackGroundY === null ? 'unavailable; fly mode remains on' : 'enabled'}.`;
    syncGlbVisibilityButton();
    syncSceneControls();
    if (!applySavedSpawnIfAny()) {
        setStatus(`Loaded ${filename}. ${physicsMessage}`);
    }
};

const loadGlbFromFile = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
        await loadGlbFromUrl(url, file.name);
    } finally {
        URL.revokeObjectURL(url);
    }
};

const loadSceneFromEntry = async (scene: SceneEntry) => {
    try {
        setStatus(`Loading scene ${scene.name}...`);
        await loadSplatFromUrl(resolveSceneAsset(scene.splat));
        if (scene.glb) {
            await loadGlbFromUrl(resolveSceneAsset(scene.glb), scene.glb);
        }

        activeSceneKey = sceneEntryKey(scene);
        renderSceneList(currentSceneCatalog);
        loaderPanel.classList.add('is-hidden');
        toggleScenesPanel(false);
        syncSceneControls();
    } catch (error) {
        console.error(error);
        setStatus(`Failed to load scene ${scene.name}: ${(error instanceof Error ? error.message : String(error))}`);
    }
};

let selectedScene: SceneEntry | null = null;

const selectScene = (scene: SceneEntry) => {
    selectedScene = scene;

    const quickThumb = document.getElementById('quick-thumb') as HTMLImageElement;
    const quickTitle = document.getElementById('quick-title') as HTMLElement;
    const quickDesc = document.getElementById('quick-desc') as HTMLElement;
    const quickSplatFile = document.getElementById('quick-splat-file') as HTMLElement;
    const quickGlbFile = document.getElementById('quick-glb-file') as HTMLElement;

    if (quickThumb && scene.thumbnail) {
        quickThumb.src = resolveSceneUrl(`./scenes/${scene.thumbnail}`);
        quickThumb.alt = scene.name;
    }
    if (quickTitle) {
        quickTitle.textContent = scene.name.toUpperCase();
    }
    if (quickDesc) {
        quickDesc.textContent = scene.description ?? '';
    }
    if (quickSplatFile) {
        quickSplatFile.textContent = `Splat: ${scene.splat}`;
    }
    if (quickGlbFile) {
        quickGlbFile.textContent = `GLB: ${scene.glb ?? 'None'}`;
    }

    const infoTitle = document.getElementById('info-title') as HTMLElement;
    const infoLocation = document.getElementById('info-location') as HTMLElement;
    const infoDesc = document.getElementById('info-desc') as HTMLElement;

    if (infoTitle) {
        infoTitle.textContent = scene.name;
    }
    if (infoLocation) {
        infoLocation.textContent = (scene as any).location ?? 'Victoria Falls, Zimbabwe';
    }
    if (infoDesc) {
        infoDesc.textContent = scene.description ?? 'Experience the beauty of Zimbabwe through immersive 3D exploration. Walk freely, look around, and discover every detail.';
    }

    const cards = sceneList.getElementsByClassName('scene-entry');
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i] as HTMLElement;
        const cardSceneName = card.dataset.sceneName;
        const cardSceneSplat = card.dataset.sceneSplat;

        if (cardSceneName === scene.name && cardSceneSplat === scene.splat) {
            card.classList.add('scene-entry--selected');
        } else {
            card.classList.remove('scene-entry--selected');
        }
    }
};

const renderSceneList = (scenes: SceneEntry[]) => {
    sceneList.innerHTML = '';
    if (!scenes.length) {
        sceneList.textContent = 'No scenes found.';
        return;
    }

    for (const scene of scenes) {
        const entry = document.createElement('article');
        entry.className = 'scene-entry';
        entry.dataset.sceneName = scene.name;
        entry.dataset.sceneSplat = scene.splat;

        if (sceneEntryKey(scene) === activeSceneKey) {
            entry.classList.add('scene-entry--active');
            const checkmark = document.createElement('div');
            checkmark.className = 'active-checkmark-badge';
            checkmark.innerHTML = '✓';
            entry.appendChild(checkmark);
        }

        if (selectedScene && scene.name === selectedScene.name && scene.splat === selectedScene.splat) {
            entry.classList.add('scene-entry--selected');
        }

        if (scene.thumbnail) {
            const thumb = document.createElement('img');
            thumb.src = resolveSceneUrl(`./scenes/${scene.thumbnail}`);
            thumb.alt = scene.name;
            entry.appendChild(thumb);
        }

        const title = document.createElement('h3');
        title.textContent = scene.name.toUpperCase();
        entry.appendChild(title);

        const location = document.createElement('div');
        location.className = 'scene-location';
        location.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span>${(scene as any).location ?? 'Victoria Falls, Zimbabwe'}</span>
        `;
        entry.appendChild(location);

        const isCustomScene = customSceneManifest.some(
            s => s.name === scene.name && s.splat === scene.splat
        );

        if (isCustomScene) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'delete-scene-btn';
            deleteButton.innerHTML = '×';
            deleteButton.title = 'Delete scene';
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const confirmDelete = confirm(`Delete scene "${scene.name}"?`);
                if (confirmDelete) {
                    deleteCustomScene(scene);
                }
            });
            entry.appendChild(deleteButton);
        }

        entry.addEventListener('click', () => {
            selectScene(scene);
        });

        entry.addEventListener('dblclick', () => {
            void loadSceneFromEntry(scene);
        });

        sceneList.appendChild(entry);
    }

    const addCard = document.createElement('article');
    addCard.className = 'scene-entry add-new-card';
    addCard.innerHTML = `
        <div class="add-new-plus">+</div>
        <div class="add-new-title">ADD NEW SCENE</div>
        <div class="add-new-sub">Register a new scene</div>
    `;
    addCard.addEventListener('click', () => {
        registerCurrentScene();
    });
    sceneList.appendChild(addCard);
};

const deleteCustomScene = (scene: SceneEntry) => {
    customSceneManifest = customSceneManifest.filter(entry => entry.name !== scene.name || entry.splat !== scene.splat);
    setStoredScenes(customSceneManifest);
    if (sceneEntryKey(scene) === activeSceneKey) {
        activeSceneKey = '';
    }
    currentSceneCatalog = [...customSceneManifest, ...defaultSceneManifest];
    renderSceneList(currentSceneCatalog);
    setStatus(`Deleted scene "${scene.name}".`);
};

const loadSceneList = async () => {
    customSceneManifest = getStoredScenes();
    try {
        const response = await fetch(resolveSceneUrl('./scenes/manifest.json'));
        if (!response.ok) {
            throw new Error(`Scene manifest not found (${response.status})`);
        }

        const scenes = await response.json() as SceneEntry[];
        if (!Array.isArray(scenes)) {
            throw new Error('Invalid scene manifest format');
        }

        currentSceneCatalog = [...customSceneManifest, ...scenes];
        if (currentSceneCatalog.length > 0) {
            selectScene(currentSceneCatalog[0]);
        }
        renderSceneList(currentSceneCatalog);
    } catch (error) {
        console.error(error);
        sceneList.textContent = 'Loading default scenes...';
        currentSceneCatalog = [...customSceneManifest, ...defaultSceneManifest];
        if (currentSceneCatalog.length > 0) {
            selectScene(currentSceneCatalog[0]);
        }
        renderSceneList(currentSceneCatalog);
        const detail = error instanceof Error ? error.message : String(error);
        setStatus(`Scene dashboard fallback: ${detail}`);
    }
};

void loadSceneList();

const loadSelectedFiles = async () => {
    try {
        const splatFile = splatInput.files?.[0] ?? null;
        const glbFile = glbInput.files?.[0] ?? null;

        if (!splatFile && !glbFile) {
            setStatus('Choose a splat or GLB file first.');
            return;
        }

        if (splatFile) {
            await loadSplatFromFile(splatFile);
        }

        if (glbFile) {
            await loadGlbFromFile(glbFile);
        }

        loaderPanel.classList.add('is-hidden');
        toggleScenesPanel(false);
        syncSceneControls();
    } catch (error) {
        console.error(error);
        setStatus(`Load failed: ${(error instanceof Error ? error.message : String(error))}`);
    }
};

const tryLoadDroppedFiles = async (files: FileList) => {
    const allFiles = Array.from(files);
    const splatFile = allFiles.find(file => ['splat', 'ply', 'sog', 'json', 'ksplat', 'spz'].includes(extensionOf(file.name)));
    const glbFile = allFiles.find(file => ['glb', 'gltf'].includes(extensionOf(file.name)));

    try {
        if (splatFile) {
            await loadSplatFromFile(splatFile);
        }
        if (glbFile) {
            await loadGlbFromFile(glbFile);
            loaderPanel.classList.add('is-hidden');
        }
        if (!splatFile && !glbFile) {
            setStatus('Drop a .splat/.ply/.sog file and optionally a .glb file.');
        }
        if (splatFile || glbFile) {
            toggleScenesPanel(false);
        }
    } catch (error) {
        console.error(error);
        setStatus(`Drop load failed: ${(error instanceof Error ? error.message : String(error))}`);
    }
};

const promptForFiles = () => {
    setStatus('Choose a splat file first, then optionally add a GLB.');
    splatInput.click();
};

const saveCurrentSpawnOnExit = () => {
    if (activeSplatId || activeGlbId) {
        saveSpawnPose();
    }
};

const registerCurrentScene = () => {
    if (!activeSplatId && !activeGlbId) {
        setStatus('Load a scene first to register it.');
        return;
    }

    const sceneName = prompt('Enter a name for this scene:', activeSplatId || activeGlbId || 'New scene');
    if (!sceneName) {
        return;
    }

    const splatPath = activeSplatId && isPersistableScenePath(activeSplatId) ? getPersistableScenePath(activeSplatId) : undefined;
    const glbPath = activeGlbId && isPersistableScenePath(activeGlbId) ? getPersistableScenePath(activeGlbId) : undefined;

    if (!splatPath) {
        setStatus('This scene cannot be registered because the splat source is not persistable. Use a scene from the local scenes catalog.');
        return;
    }

    const entry: SceneEntry = {
        name: sceneName,
        description: 'Registered scene',
        splat: splatPath,
        glb: glbPath
    };

    customSceneManifest = [entry, ...customSceneManifest.filter(scene => scene.name !== entry.name || scene.splat !== entry.splat)];
    setStoredScenes(customSceneManifest);
    renderSceneList([...customSceneManifest, ...defaultSceneManifest]);
    setStatus(`Scene registered as “${sceneName}”. Use the dashboard to open it later.`);
};

const exitViewer = () => {
    saveCurrentSpawnOnExit();
    if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
    }

    loaderPanel.classList.remove('is-hidden');
    toggleScenesPanel(true);
    setStatus('Exited scene view. Pick a scene from the dashboard or load files.');
};

const toggleScenesPanel = (show: boolean) => {
    centerPanel.classList.toggle('is-hidden', !show);
    if (show) {
        setStatus('Scene browser open. Double-click a scene to load it.');
    } else {
        setStatus('Scene browser closed. Continue your view or click the view to walk.');
    }
};

const requestPointerLock = (event?: Event) => {
    if (event && isInteractiveTarget(event.target)) {
        return;
    }

    canvas.focus({ preventScroll: true });

    try {
        (canvas as any).requestPointerLock();
    } catch (error) {
        console.error(error);
        setStatus('Mouse look could not start. Click the 3D view again, or reload the page if it stays blocked.');
    }
};

loadFilesButton.addEventListener('click', () => {
    if (!splatInput.files?.length && !glbInput.files?.length) {
        promptForFiles();
        return;
    }

    void loadSelectedFiles();
});

const splatTrigger = document.getElementById('splat-trigger') as HTMLButtonElement;
const glbTrigger = document.getElementById('glb-trigger') as HTMLButtonElement;
const splatFileName = document.getElementById('splat-file-name') as HTMLElement;
const glbFileName = document.getElementById('glb-file-name') as HTMLElement;

splatTrigger?.addEventListener('click', () => splatInput.click());
glbTrigger?.addEventListener('click', () => glbInput.click());

splatInput.addEventListener('change', () => {
    if (splatInput.files?.length) {
        if (splatFileName) splatFileName.textContent = splatInput.files[0].name;
        setStatus(glbInput.files?.length ?
            'Files selected. Click Load Files to start.' :
            'Splat selected. Add a GLB if you want collisions, then click Load Files.');
    } else {
        if (splatFileName) splatFileName.textContent = 'No file chosen';
    }
});

glbInput.addEventListener('change', () => {
    if (glbInput.files?.length) {
        if (glbFileName) glbFileName.textContent = glbInput.files[0].name;
        setStatus(splatInput.files?.length ?
            'Files selected. Click Load Files to start.' :
            'GLB selected. Add a splat, then click Load Files.');
    } else {
        if (glbFileName) glbFileName.textContent = 'No file chosen';
    }
});

const exploreSceneBtn = document.getElementById('explore-scene-btn') as HTMLButtonElement;
exploreSceneBtn?.addEventListener('click', () => {
    if (selectedScene) {
        void loadSceneFromEntry(selectedScene);
    }
});

const gridViewBtn = document.getElementById('grid-view-btn') as HTMLButtonElement;
const listViewBtn = document.getElementById('list-view-btn') as HTMLButtonElement;

gridViewBtn?.addEventListener('click', () => {
    gridViewBtn.classList.add('active');
    listViewBtn?.classList.remove('active');
    sceneList.classList.remove('list-view');
    sceneList.classList.add('grid-view');
});

listViewBtn?.addEventListener('click', () => {
    listViewBtn.classList.add('active');
    gridViewBtn?.classList.remove('active');
    sceneList.classList.remove('grid-view');
    sceneList.classList.add('list-view');
});

lockPointerButton.addEventListener('click', (event) => {
    requestPointerLock(event);
});
saveSpawnButton.addEventListener('click', saveSpawnPose);
goSpawnButton.addEventListener('click', goToSpawnPose);
clearSpawnButton.addEventListener('click', clearSpawnPose);
registerSceneButton.addEventListener('click', registerCurrentScene);
exitViewerButton.addEventListener('click', exitViewer);
leaveViewerButton.addEventListener('click', exitViewer);
showScenesButton.addEventListener('click', () => toggleScenesPanel(true));
closeScenesButton.addEventListener('click', () => toggleScenesPanel(false));
toggleGlbButton.addEventListener('click', () => {
    setGlbVisible(!glbVisible);
});
canvas.tabIndex = 0;
canvas.addEventListener('click', (event) => {
    requestPointerLock(event);
});
uiRoot.addEventListener('click', (event) => {
    if (!isInteractiveTarget(event.target)) {
        requestPointerLock(event);
    }
});

document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    document.body.classList.toggle('is-locked', locked);
    if (!locked) {
        pressed.clear();
    }
    setStatus(locked ? 'Walking: WASD, mouse look, Shift sprint.' : 'Paused. Click the view to continue.');
});

document.addEventListener('pointerlockerror', () => {
    setStatus('Mouse look was blocked by the browser. Click directly on the view, then try again.');
});

document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement !== canvas) {
        return;
    }

    yaw -= event.movementX * 0.11;
    pitch -= event.movementY * 0.11;
    pitch = Math.max(-88, Math.min(88, pitch));
    camera.setEulerAngles(pitch, yaw, 0);
});

document.addEventListener('keydown', (event) => {
    pressed.add(event.code);

    if (event.code === 'Equal') {
        moveSpeed = Math.min(8, moveSpeed + 0.2);
        setStatus(`Walk speed ${moveSpeed.toFixed(1)} m/s`);
    } else if (event.code === 'Minus') {
        moveSpeed = Math.max(0.4, moveSpeed - 0.2);
        setStatus(`Walk speed ${moveSpeed.toFixed(1)} m/s`);
    } else if (event.code === 'KeyF') {
        flyMode = !flyMode;
        verticalVelocity = 0;
        setStatus(flyMode ? 'Fly mode enabled.' : 'Physics walking enabled.');
    } else if (event.code === 'Space' && grounded && !flyMode) {
        verticalVelocity = jumpSpeed;
        grounded = false;
    }
});

document.addEventListener('keyup', (event) => {
    pressed.delete(event.code);
});

window.addEventListener('blur', () => {
    pressed.clear();
});

document.addEventListener('dragover', (event) => {
    event.preventDefault();
});

document.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files) {
        void tryLoadDroppedFiles(event.dataTransfer.files);
    }
});

window.addEventListener('resize', () => {
    app.resizeCanvas();
    app.updateCanvasSize();
});

window.addEventListener('beforeunload', () => {
    saveCurrentSpawnOnExit();
});

app.on('update', (dt: number) => {
    const speed = moveSpeed * (pressed.has('ShiftLeft') || pressed.has('ShiftRight') ? 2.2 : 1);
    const step = speed * dt;
    const yawRad = yaw * Math.PI / 180;
    const physicsActive = (collisionTriangles.length > 0 || fallbackGroundY !== null) && !flyMode;
    let x = 0;
    let y = 0;
    let z = 0;

    if (pressed.has('KeyW') || pressed.has('ArrowUp')) {
        x -= Math.sin(yawRad);
        z -= Math.cos(yawRad);
    }
    if (pressed.has('KeyS') || pressed.has('ArrowDown')) {
        x += Math.sin(yawRad);
        z += Math.cos(yawRad);
    }
    if (pressed.has('KeyA') || pressed.has('ArrowLeft')) {
        x -= Math.cos(yawRad);
        z += Math.sin(yawRad);
    }
    if (pressed.has('KeyD') || pressed.has('ArrowRight')) {
        x += Math.cos(yawRad);
        z -= Math.sin(yawRad);
    }
    if (pressed.has('Space') && !physicsActive) {
        y += 1;
    }
    if (!physicsActive && (pressed.has('KeyC') || pressed.has('ControlLeft') || pressed.has('ControlRight'))) {
        y -= 1;
    }

    if (physicsActive) {
        tempPosition.copy(camera.getPosition());

        const horizontalLength = Math.hypot(x, z);
        if (horizontalLength > 0) {
            tempPosition.x += (x / horizontalLength) * step;
            tempPosition.z += (z / horizontalLength) * step;
        }

        if (grounded && verticalVelocity <= 0) {
            verticalVelocity = 0;
        } else {
            verticalVelocity += gravity * dt;
        }

        const moving = horizontalLength > 0 || verticalVelocity !== 0 || !grounded;
        if (moving) {
            tempPosition.y += verticalVelocity * dt;
            resolveCollisions(tempPosition);

            const groundY = findGroundY(tempPosition);
            if (groundY !== null && tempPosition.y - playerHeight <= groundY + groundSnapDistance) {
                const targetY = groundY + playerHeight;
                if (grounded) {
                    const smoothY = tempPosition.y + (targetY - tempPosition.y) * 0.18;
                    tempPosition.y = Math.abs(smoothY - targetY) < 0.01 ? targetY : smoothY;
                } else {
                    tempPosition.y = targetY;
                }
                verticalVelocity = 0;
                grounded = true;
            } else {
                grounded = false;
            }

            camera.setPosition(tempPosition);
        }
    } else {
        const length = Math.hypot(x, y, z);
        if (length === 0) {
            return;
        }

        tempPosition.copy(camera.getPosition());
        tempPosition.x += (x / length) * step;
        tempPosition.y += (y / length) * step;
        tempPosition.z += (z / length) * step;
        camera.setPosition(tempPosition);
    }
});

const params = new URLSearchParams(window.location.search);
const splatUrl = params.get('splat') ?? params.get('ply') ?? params.get('load');
const glbUrl = params.get('glb') ?? params.get('model');

syncGlbVisibilityButton();
syncSceneControls();
app.start();

try {
    if (splatUrl) {
        await loadSplatFromUrl(splatUrl);
    }

    if (glbUrl) {
        await loadGlbFromUrl(new URL(glbUrl, window.location.href).toString(), glbUrl);
        loaderPanel.classList.add('is-hidden');
    }

    if (!splatUrl && !glbUrl) {
        setStatus('Drop files or use the loader.');
    }
} catch (error) {
    console.error(error);
    setStatus(`Startup load failed: ${(error instanceof Error ? error.message : String(error))}`);
}
