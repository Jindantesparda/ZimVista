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

import { BrowserFileSystem, MappedReadFileSystem, loadGSplatData, validateGSplatData } from './io';
import { serializeCollisionGlb } from './splat-serialize';
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
const openSettingsButton = document.getElementById('open-settings') as HTMLButtonElement;
const closeSettingsButton = document.getElementById('close-settings') as HTMLButtonElement;
const exportCollisionButton = document.getElementById('export-collision') as HTMLButtonElement;
const centerPanel = document.getElementById('center-panel') as HTMLElement;
const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
const settingsToast = document.getElementById('settings-toast') as HTMLElement;
let settingsToastTimer: number | null = null;
let loadedSettingsFromStorage = false;
const toggleGlbButton = document.getElementById('toggle-glb') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const uiRoot = document.getElementById('viewer-ui') as HTMLElement;
const annotationPopup = document.getElementById('annotation-popup') as HTMLElement;
const annotationModeLabel = document.getElementById('annotation-mode-label') as HTMLElement;
const addAnnotationButton = document.getElementById('add-annotation-btn') as HTMLButtonElement;
const drawArrowButton = document.getElementById('draw-arrow-btn') as HTMLButtonElement;
const exportAnnotationsButton = document.getElementById('export-annotations') as HTMLButtonElement;
const importAnnotationsButton = document.getElementById('import-annotations') as HTMLButtonElement;
const importAnnotationsFile = document.getElementById('import-annotations-file') as HTMLInputElement;
const annotationListContainer = document.getElementById('annotation-list') as HTMLElement;

const setStatus = (message: string) => {
    statusEl.textContent = message;
};

type AnnotationMode = 'off' | 'note' | 'arrow';

interface Annotation {
    id: string;
    sceneKey: string;
    position: [number, number, number];
    title: string;
    note: string;
    arrowDirection?: [number, number, number];
    createdAt: string;
}

const annotationStorageKey = 'supersplat.walkthrough.annotations';
let annotationMode: AnnotationMode = 'off';
let annotations: Annotation[] = [];

const getAnnotationSceneKey = () => {
    return activeSceneKey || `${activeSplatId}|${activeGlbId}`;
};

const removeExtension = (filename: string) => filename.replace(/[#?].*$/, '').replace(/\.[^.]+$/, '');

const loadAnnotationsStore = (): Record<string, Annotation[]> => {
    try {
        const raw = window.localStorage.getItem(annotationStorageKey);
        return raw ? JSON.parse(raw) as Record<string, Annotation[]> : {};
    } catch {
        return {};
    }
};

const saveAnnotationsStore = (store: Record<string, Annotation[]>) => {
    try {
        window.localStorage.setItem(annotationStorageKey, JSON.stringify(store));
    } catch {
        // ignore storage failures
    }
};

const getAnnotationsForCurrentScene = (): Annotation[] => {
    const store = loadAnnotationsStore();
    return store[getAnnotationSceneKey()] ?? [];
};

const persistAnnotationsForCurrentScene = (updated: Annotation[]) => {
    const store = loadAnnotationsStore();
    store[getAnnotationSceneKey()] = updated;
    saveAnnotationsStore(store);
    annotations = updated;
};

const formatCoordinates = (position: [number, number, number]) =>
    position.map((value) => value.toFixed(2)).join(', ');

const refreshAnnotationPanel = () => {
    annotations = getAnnotationsForCurrentScene();
    if (!annotationListContainer) {
        return;
    }

    if (annotations.length === 0) {
        annotationListContainer.innerHTML = '<div class="annotation-empty">No annotations yet. Use Add Note or Draw Arrow to place one.</div>';
        return;
    }

    annotationListContainer.innerHTML = annotations.map((annotation) => `
        <article class="annotation-entry" data-id="${annotation.id}">
            <div class="annotation-entry-title">
                <span>${annotation.title}</span>
                <button type="button" class="annotation-entry-view" data-id="${annotation.id}">View</button>
            </div>
            <div class="annotation-entry-meta">${annotation.arrowDirection ? 'Arrow' : 'Note'} · ${formatCoordinates(annotation.position)}</div>
            ${annotation.note ? `<div class="annotation-entry-note">${annotation.note}</div>` : ''}
        </article>
    `).join('');
};

const setAnnotationMode = (mode: AnnotationMode) => {
    annotationMode = mode;
    if (!annotationModeLabel) {
        return;
    }
    annotationModeLabel.textContent = `Mode: ${mode === 'off' ? 'Off' : mode === 'note' ? 'Note' : 'Draw Arrow'}`;
    addAnnotationButton?.classList.toggle('active', mode === 'note');
    drawArrowButton?.classList.toggle('active', mode === 'arrow');
    if (mode !== 'off') {
        showSettingsToast('Right-click the 3D view to place an annotation.');
    }
};

const hideAnnotationPopup = () => {
    if (!annotationPopup) {
        return;
    }
    annotationPopup.classList.remove('visible');
    annotationPopup.innerHTML = '';
};

const createAnnotationEditor = (position: [number, number, number], arrowDirection?: [number, number, number]) => {
    if (!annotationPopup) {
        return;
    }

    annotationPopup.dataset.position = JSON.stringify(position);
    annotationPopup.dataset.arrow = arrowDirection ? JSON.stringify(arrowDirection) : '';
    annotationPopup.dataset.mode = annotationMode;

    annotationPopup.innerHTML = `
        <div class="annotation-popup-shell">
            <div class="annotation-popup-title">${annotationMode === 'arrow' ? 'New Arrow Annotation' : 'New Surface Note'}</div>
            <div class="annotation-popup-meta">Location: ${formatCoordinates(position)}</div>
            ${arrowDirection ? `<div class="annotation-popup-meta">Direction: ${formatCoordinates(arrowDirection)}</div>` : ''}
            <label class="annotation-popup-field">
                Title
                <input id="annotation-title" type="text" placeholder="Describe this spot" />
            </label>
            <label class="annotation-popup-field">
                Notes
                <textarea id="annotation-note" placeholder="Add a note for this location..."></textarea>
            </label>
            <div class="annotation-popup-buttons">
                <button type="button" class="secondary" data-action="cancel">Cancel</button>
                <button type="button" class="primary" data-action="save">Save</button>
            </div>
        </div>
    `;

    annotationPopup.classList.add('visible');
};

const saveAnnotationFromPopup = () => {
    if (!annotationPopup) {
        return;
    }

    const positionData = annotationPopup.dataset.position;
    if (!positionData) {
        hideAnnotationPopup();
        return;
    }

    const position = JSON.parse(positionData) as [number, number, number];
    const arrowData = annotationPopup.dataset.arrow;
    const arrowDirection = arrowData ? JSON.parse(arrowData) as [number, number, number] : undefined;
    const titleInput = document.getElementById('annotation-title') as HTMLInputElement | null;
    const noteInput = document.getElementById('annotation-note') as HTMLTextAreaElement | null;
    const title = titleInput?.value.trim() || (annotationMode === 'arrow' ? 'Arrow annotation' : 'New annotation');
    const note = noteInput?.value.trim() || '';

    const annotation: Annotation = {
        id: `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        sceneKey: getAnnotationSceneKey(),
        position,
        title,
        note,
        arrowDirection,
        createdAt: new Date().toISOString()
    };

    annotations = [...annotations, annotation];
    persistAnnotationsForCurrentScene(annotations);
    refreshAnnotationPanel();
    hideAnnotationPopup();
    showSettingsToast('Annotation saved.');
};

const openAnnotationEditor = (position: [number, number, number], arrowDirection?: [number, number, number]) => {
    createAnnotationEditor(position, arrowDirection);
};

const createRayFromScreen = (x: number, y: number) => {
    const cam = camera.camera;
    const near = new Vec3();
    const far = new Vec3();
    cam.screenToWorld(x, y, cam.nearClip, near);
    cam.screenToWorld(x, y, cam.farClip, far);
    return {
        origin: camera.getPosition().clone(),
        direction: far.sub(near).normalize()
    };
};

const intersectRayTriangle = (origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3) => {
    const edge1 = scratchA.sub2(b, a);
    const edge2 = scratchB.sub2(c, a);
    const pvec = scratchC.cross(direction, edge2);
    const det = edge1.dot(pvec);
    if (Math.abs(det) < 1e-6) {
        return null;
    }

    const invDet = 1 / det;
    const tvec = scratchD.sub2(origin, a);
    const u = tvec.dot(pvec) * invDet;
    if (u < 0 || u > 1) {
        return null;
    }

    const qvec = scratchE.cross(tvec, edge1);
    const v = direction.dot(qvec) * invDet;
    if (v < 0 || u + v > 1) {
        return null;
    }

    const t = edge2.dot(qvec) * invDet;
    if (t <= 0) {
        return null;
    }

    return t;
};

const getSurfaceHit = (event: MouseEvent): { position: [number, number, number]; arrowDirection?: [number, number, number] } | null => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const { origin, direction } = createRayFromScreen(x, y);
    let closestT: number | null = null;

    if (collisionTriangles.length > 0) {
        for (const triangle of collisionTriangles) {
            const t = intersectRayTriangle(origin, direction, triangle.a, triangle.b, triangle.c);
            if (t !== null && t > 0 && (closestT === null || t < closestT)) {
                closestT = t;
            }
        }

        if (closestT !== null) {
            const hitPoint = origin.clone().add(direction.clone().mulScalar(closestT));
            return {
                position: [hitPoint.x, hitPoint.y, hitPoint.z],
                arrowDirection: [direction.x, direction.y, direction.z]
            };
        }
    }

    const surfaceY = splatEntity ? ((splatEntity as any).gsplat?.asset?.resource?.aabb?.getMin().y ?? 0) : 0;
    if (Math.abs(direction.y) < 1e-6) {
        return null;
    }

    const t = (surfaceY - origin.y) / direction.y;
    if (t > 0) {
        const hitPoint = origin.clone().add(direction.clone().mulScalar(t));
        return {
            position: [hitPoint.x, hitPoint.y, hitPoint.z],
            arrowDirection: [direction.x, direction.y, direction.z]
        };
    }

    return null;
};

const handleAnnotationClick = (event: MouseEvent) => {
    event.preventDefault();

    if (annotationMode === 'off') {
        return;
    }

    if (!splatEntity && !glbEntity) {
        showSettingsToast('Load a scene first to place annotations.');
        return;
    }

    const hit = getSurfaceHit(event);
    if (!hit) {
        showSettingsToast('No surface hit. Aim at a visible scene surface and try again.');
        return;
    }

    openAnnotationEditor(hit.position, annotationMode === 'arrow' ? hit.arrowDirection : undefined);
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
const settingsStorageKey = 'supersplat.walkthrough.settings';
const lastSceneStorageKey = 'supersplat.walkthrough.lastScene';

interface ViewerSettings {
    qualityPreset: 'auto' | 'low' | 'medium' | 'high' | 'ultra';
    renderScale: number;
    showCollisionMesh: boolean;
    showCrosshair: boolean;
    uiAnimations: boolean;
    walkSpeed: number;
    sprintSpeed: number;
    mouseSensitivity: number;
    invertYAxis: boolean;
    startInFlyMode: boolean;
    showHud: boolean;
    autoHideUi: boolean;
    showHelpHints: boolean;
    showSceneInfoCard: boolean;
    defaultSceneView: 'grid' | 'list';
    fpsCounter: boolean;
    coordinates: boolean;
    debugOverlay: boolean;
    rememberLastScene: boolean;
    restoreSpawnPoint: boolean;
}

const defaultSettings: ViewerSettings = {
    qualityPreset: 'auto',
    renderScale: 1,
    showCollisionMesh: true,
    showCrosshair: true,
    uiAnimations: true,
    walkSpeed: 2.4,
    sprintSpeed: 4.8,
    mouseSensitivity: 1.0,
    invertYAxis: false,
    startInFlyMode: false,
    showHud: true,
    autoHideUi: true,
    showHelpHints: true,
    showSceneInfoCard: true,
    defaultSceneView: 'grid',
    fpsCounter: false,
    coordinates: false,
    debugOverlay: false,
    rememberLastScene: false,
    restoreSpawnPoint: true
};

let viewerSettings: ViewerSettings = defaultSettings;

const loadViewerSettings = (): ViewerSettings => {
    try {
        const raw = window.localStorage.getItem(settingsStorageKey);
        if (!raw) {
            loadedSettingsFromStorage = false;
            return { ...defaultSettings };
        }

        const parsed = JSON.parse(raw) as Partial<ViewerSettings>;
        loadedSettingsFromStorage = true;
        return { ...defaultSettings, ...parsed };
    } catch {
        loadedSettingsFromStorage = false;
        return { ...defaultSettings };
    }
};

const saveViewerSettings = () => {
    try {
        window.localStorage.setItem(settingsStorageKey, JSON.stringify(viewerSettings));
    } catch {
        // ignore storage failures
    }
};

const showSettingsToast = (message: string) => {
    if (!settingsToast) {
        return;
    }

    settingsToast.textContent = message;
    settingsToast.classList.add('visible');

    if (settingsToastTimer !== null) {
        window.clearTimeout(settingsToastTimer);
    }

    settingsToastTimer = window.setTimeout(() => {
        settingsToast.classList.remove('visible');
        settingsToastTimer = null;
    }, 3000);
};

const saveLastSceneEntry = (scene: SceneEntry) => {
    try {
        window.localStorage.setItem(lastSceneStorageKey, JSON.stringify(scene));
    } catch {
        // ignore storage failures
    }
};

const getLastSceneEntry = (): SceneEntry | null => {
    try {
        const raw = window.localStorage.getItem(lastSceneStorageKey);
        return raw ? JSON.parse(raw) as SceneEntry : null;
    } catch {
        return null;
    }
};

const settingsPanelOpen = () => {
    settingsPanel.classList.remove('is-hidden');
    settingsPanel.setAttribute('aria-hidden', 'false');
};
const settingsPanelClose = () => {
    settingsPanel.classList.add('is-hidden');
    settingsPanel.setAttribute('aria-hidden', 'true');
};

const applySettings = () => {
    document.body.classList.toggle('no-auto-hide', !viewerSettings.autoHideUi);
    document.getElementById('hud')!.style.display = viewerSettings.showHud ? 'flex' : 'none';
    document.getElementById('help')!.style.display = viewerSettings.showHelpHints ? 'flex' : 'none';
    const infoCard = document.querySelector('.info-card') as HTMLElement;
    if (infoCard) {
        infoCard.style.display = viewerSettings.showSceneInfoCard ? 'flex' : 'none';
    }
    const crosshair = document.getElementById('crosshair') as HTMLElement;
    if (crosshair) {
        crosshair.style.opacity = viewerSettings.showCrosshair ? '0.85' : '0';
    }
    if (viewerSettings.showCollisionMesh && glbEntity) {
        setGlbVisible(true);
    }
    if (!viewerSettings.showCollisionMesh && glbEntity) {
        setGlbVisible(false);
    }
    document.getElementById('scene-list')?.classList.toggle('list-view', viewerSettings.defaultSceneView === 'list');
    document.getElementById('scene-list')?.classList.toggle('grid-view', viewerSettings.defaultSceneView === 'grid');
    const debugOverlay = document.getElementById('debug-overlay') as HTMLElement | null;
    if (debugOverlay) {
        debugOverlay.classList.toggle('visible', viewerSettings.debugOverlay || viewerSettings.fpsCounter || viewerSettings.coordinates);
    }
    moveSpeed = viewerSettings.walkSpeed;
    if (viewerSettings.startInFlyMode) {
        flyMode = true;
    }
};

const updateSettingsUI = () => {
    viewerSettings = loadViewerSettings();
    saveViewerSettings();

    const fillInput = (id: string, value: string | number | boolean) => {
        const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (!el) return;
        if (el.type === 'checkbox') {
            (el as HTMLInputElement).checked = Boolean(value);
        } else if (el.type === 'radio') {
            const radios = document.querySelectorAll<HTMLInputElement>(`input[name="${el.name}"][value="${value}"]`);
            radios.forEach(r => r.checked = true);
        } else {
            el.value = String(value);
        }
    };

    fillInput('setting-quality', viewerSettings.qualityPreset);
    fillInput('setting-render-scale', viewerSettings.renderScale);
    fillInput('setting-show-collision', viewerSettings.showCollisionMesh);
    fillInput('setting-show-crosshair', viewerSettings.showCrosshair);
    fillInput('setting-ui-animations', viewerSettings.uiAnimations);
    fillInput('setting-walk-speed', viewerSettings.walkSpeed);
    fillInput('setting-sprint-speed', viewerSettings.sprintSpeed);
    fillInput('setting-mouse-sensitivity', viewerSettings.mouseSensitivity);
    fillInput('setting-invert-y', viewerSettings.invertYAxis);
    fillInput('setting-start-fly', viewerSettings.startInFlyMode);
    fillInput('setting-show-hud', viewerSettings.showHud);
    fillInput('setting-auto-hide-ui', viewerSettings.autoHideUi);
    fillInput('setting-show-help', viewerSettings.showHelpHints);
    fillInput('setting-show-scene-info', viewerSettings.showSceneInfoCard);
    const defaultSceneRadio = document.querySelector<HTMLInputElement>(`input[name="defaultSceneView"][value="${viewerSettings.defaultSceneView}"]`);
    if (defaultSceneRadio) {
        defaultSceneRadio.checked = true;
    }
    fillInput('setting-fps-counter', viewerSettings.fpsCounter);
    fillInput('setting-coordinates', viewerSettings.coordinates);
    fillInput('setting-debug-overlay', viewerSettings.debugOverlay);
    fillInput('setting-remember-last-scene', viewerSettings.rememberLastScene);
    fillInput('setting-restore-spawn-point', viewerSettings.restoreSpawnPoint);
    applySettings();
};

const setViewerSetting = <K extends keyof ViewerSettings>(key: K, value: ViewerSettings[K]) => {
    viewerSettings[key] = value;
    saveViewerSettings();
    applySettings();
    showSettingsToast('Settings saved.');
};

const loadViewerSettingsIntoUI = () => {
    viewerSettings = loadViewerSettings();
    updateSettingsUI();

    if (loadedSettingsFromStorage) {
        showSettingsToast('Settings restored from last session.');
    }
};

const getSettingValue = (target: HTMLInputElement | HTMLSelectElement): string | number | boolean => {
    if (target.type === 'checkbox') {
        return (target as HTMLInputElement).checked;
    }
    if (target.type === 'radio') {
        return (target as HTMLInputElement).value;
    }
    if (target.type === 'range' || target.type === 'number') {
        return target.valueAsNumber || Number(target.value);
    }
    if (target.tagName.toLowerCase() === 'select') {
        return target.value;
    }
    return target.value;
};

const applyInputSetting = (target: HTMLInputElement | HTMLSelectElement) => {
    const settingKey = target.dataset.setting as keyof ViewerSettings | undefined;
    if (!settingKey || !(settingKey in viewerSettings)) {
        return;
    }

    const value = getSettingValue(target);
    if (typeof viewerSettings[settingKey] === 'boolean') {
        setViewerSetting(settingKey, Boolean(value) as any);
    } else if (typeof viewerSettings[settingKey] === 'number') {
        setViewerSetting(settingKey, Number(value) as any);
    } else {
        setViewerSetting(settingKey, value as any);
    }
};

const initSettingsInputs = () => {
    settingsPanel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach((element) => {
        element.addEventListener('change', (event) => {
            applyInputSetting(event.target as HTMLInputElement | HTMLSelectElement);
        });
    });
};

const loadLastSceneIfNeeded = async () => {
    if (!viewerSettings.rememberLastScene || hasSceneQueryParams()) {
        return;
    }

    const lastScene = getLastSceneEntry();
    if (lastScene) {
        try {
            await loadSceneFromEntry(lastScene);
        } catch {
            // ignore load failures and keep the dashboard
        }
    }
};

const getDefaultSceneView = () => viewerSettings.defaultSceneView;

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
        !!target.closest('button, input, label, select, textarea, a, .annotation-popup');
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
    refreshAnnotationPanel();
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
    toggleScenesPanel(false);
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
    toggleScenesPanel(false);
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
    refreshAnnotationPanel();
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

        toggleScenesPanel(false);

        loaderPanel.classList.add('is-hidden');
        syncSceneControls();
        refreshAnnotationPanel();

        if (viewerSettings.rememberLastScene) {
            saveLastSceneEntry(scene);
        }
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

void loadSceneList().then(() => {
    loadViewerSettingsIntoUI();
    void loadLastSceneIfNeeded();
});

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
    centerPanel.classList.add('is-hidden');
    setStatus('Exited scene view. Pick a scene from the dashboard or load files.');
};

const toggleScenesPanel = (show: boolean) => {
    centerPanel.classList.toggle('is-hidden', !show);

    if (show && document.pointerLockElement === canvas) {
        document.exitPointerLock();
    }

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
showScenesButton.addEventListener('click', () => {
    if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
    }

    toggleScenesPanel(true);
});
closeScenesButton.addEventListener('click', () => toggleScenesPanel(false));
toggleGlbButton.addEventListener('click', () => {
    setGlbVisible(!glbVisible);
});
openSettingsButton.addEventListener('click', () => {
    settingsPanelOpen();
});
closeSettingsButton.addEventListener('click', () => {
    settingsPanelClose();
});
settingsPanel.addEventListener('click', (event) => {
    if (event.target === settingsPanel) {
        settingsPanelClose();
    }
});
settingsPanel.querySelectorAll<HTMLButtonElement>('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        settingsPanel.querySelectorAll<HTMLButtonElement>('.settings-tab').forEach(btn => btn.classList.remove('active'));
        settingsPanel.querySelectorAll<HTMLElement>('.settings-pane').forEach(pane => pane.classList.remove('active'));
        tab.classList.add('active');
        const paneName = tab.dataset.tab;
        const pane = settingsPanel.querySelector<HTMLElement>(`.settings-pane[data-pane="${paneName}"]`);
        if (pane) {
            pane.classList.add('active');
        }
    });
});

addAnnotationButton?.addEventListener('click', () => setAnnotationMode(annotationMode === 'note' ? 'off' : 'note'));
drawArrowButton?.addEventListener('click', () => setAnnotationMode(annotationMode === 'arrow' ? 'off' : 'arrow'));
exportAnnotationsButton?.addEventListener('click', () => {
    const data = JSON.stringify(getAnnotationsForCurrentScene(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations-${getAnnotationSceneKey().replace(/[^a-z0-9-_]/gi, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});

exportCollisionButton?.addEventListener('click', async () => {
    if (!splatEntity) {
        setStatus('Load a splat file first to export collision GLB.');
        return;
    }

    const resource = (splatEntity as any).gsplat?.asset?.resource as GSplatResource | undefined;
    if (!resource) {
        setStatus('Unable to access splat resource for export.');
        return;
    }

    const splatData = resource.gsplatData;
    const filename = `${removeExtension(activeSplatId || 'scene')}.collision.glb`;

    setStatus('Exporting collision GLB...');
    try {
        await serializeCollisionGlb([{ splatData }] as any, { maxSHBands: 3 }, new BrowserFileSystem(filename), filename);
        setStatus(`Collision GLB exported: ${filename}`);
    } catch (error) {
        console.error(error);
        setStatus(`Collision export failed: ${(error instanceof Error ? error.message : String(error))}`);
    }
});
importAnnotationsButton?.addEventListener('click', () => {
    importAnnotationsFile?.click();
});
importAnnotationsFile?.addEventListener('change', async () => {
    const file = importAnnotationsFile.files?.[0];
    if (!file) {
        return;
    }
    try {
        const raw = await file.text();
        const items = JSON.parse(raw) as Annotation[];
        persistAnnotationsForCurrentScene(items);
        refreshAnnotationPanel();
        showSettingsToast('Annotations imported.');
    } catch (error) {
        console.error(error);
        showSettingsToast('Failed to import annotations.');
    } finally {
        importAnnotationsFile.value = '';
    }
});
annotationPopup?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.dataset.action;
    if (action === 'cancel') {
        hideAnnotationPopup();
    } else if (action === 'save') {
        saveAnnotationFromPopup();
    }
});
annotationListContainer?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const id = target.dataset.id;
    if (!id) {
        return;
    }
    const selected = annotations.find((annotation) => annotation.id === id);
    if (!selected) {
        return;
    }
    const position = new Vec3(selected.position[0], selected.position[1] + 1.65, selected.position[2]);
    camera.setPosition(position);
    showSettingsToast(`Moved to annotation: ${selected.title}`);
});

initSettingsInputs();
canvas.tabIndex = 0;
canvas.addEventListener('click', (event) => {
    requestPointerLock(event);
});
canvas.addEventListener('contextmenu', handleAnnotationClick);
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

    const debugText = document.getElementById('debug-text');
    if (debugText && (viewerSettings.debugOverlay || viewerSettings.coordinates)) {
        const position = camera.getPosition();
        const lines = [];
        if (viewerSettings.coordinates) {
            lines.push(`Position: ${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`);
        }
        if (viewerSettings.debugOverlay) {
            lines.push(`Fly mode: ${flyMode ? 'ON' : 'OFF'} | Speed: ${speed.toFixed(2)} m/s`);
        }
        debugText.textContent = lines.join(' | ');
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
