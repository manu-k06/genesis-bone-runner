import './style.css';
import { supabase, initAnonymousAuth } from './supabase.js';
import { registerPlayer, lookupPlayerByPhone } from './services/playerService.js';
import { getTopPlayers, getPlayerRank } from './services/leaderboardService.js';

// ============================================================
//  STATE MANAGEMENT
// ============================================================
const STATES = {
  LOADING: 'LOADING',
  HOME: 'HOME',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  GAME_OVER: 'GAME_OVER',
  LEADERBOARD: 'LEADERBOARD',
  SETTINGS: 'SETTINGS',
  REGISTER: 'REGISTER'
};
Object.freeze(STATES);

let currentState = STATES.LOADING;
let previousState = STATES.LOADING;
let currentSessionId = null;
let currentSessionNonce = null;
let sessionStats = { jumps: 0, dodges: 0 };
let heartbeatInterval = null;
let speedMultiplier = 1;
let assetsTotal = 0;
let assetsLoaded = 0;
let failedAssets = [];
let safeArea = { top: 0, left: 0, right: 0 };

// Leaderboard scrolling state
let leaderboardScrollY = 0;
let leaderboardMaxScroll = 0;
let dragStartY = 0;
let dragStartScrollY = 0;
let isDragging = false;

// ============================================================
//  THEME CONSTANTS
// ============================================================
const THEME = {
  boneWhite: '#E8ECE0',
  boneWhiteMuted: 'rgba(232,236,224,0.5)',
  deepPurple: 'rgba(21,24,16,0.92)',
  deepPurpleSolid: '#151810',
  panelBorder: '#3D4A2E',
  darkBrown: '#1C2318',
  darkBrownHover: '#28311F',
  darkBrownPressed: '#111710',
  charcoal: '#0D0D0D',
  pumpkinOrange: '#8FD14F',
  pumpkinOrangeHover: '#A8E86B',
  pumpkinOrangePressed: '#6FA83A',
  softGreen: '#8FD14F',
  mutedRed: '#E8432F',
  overlay: 'rgba(5, 5, 5, 0.6)',
  overlayDark: 'rgba(5, 5, 5, 0.75)',
  overlayDarker: 'rgba(5, 5, 5, 0.8)',
  textShadow: 'rgba(0,0,0,0.8)',
  borderLight: 'rgba(232,236,224,0.12)',
  borderMedium: 'rgba(232,236,224,0.22)',
  neonGreen: '#39ff14'
};

const FONT = {
  title: '"MedievalSharp", cursive',
  body: '"Inter", sans-serif'
};

// ============================================================
//  EVENT DEADLINE LOGIC
// ============================================================
const EVENT_DEADLINE = new Date('2026-08-02T20:00:00+05:30').getTime();

export function isDeadlinePassed() {
  return Date.now() >= EVENT_DEADLINE;
}

function getCountdownText() {
  const now = Date.now();
  if (now >= EVENT_DEADLINE) return "Event Ended";
  const diff = EVENT_DEADLINE - now;
  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
  const h = Math.floor((diff / (1000 * 60 * 60)) % 24).toString().padStart(2, '0');
  const m = Math.floor((diff / 1000 / 60) % 60).toString().padStart(2, '0');
  const s = Math.floor((diff / 1000) % 60).toString().padStart(2, '0');
  return `Ends in: ${d}d ${h}h ${m}m ${s}s`;
}

// ============================================================
//  CANVAS
// ============================================================
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// ============================================================
//  AUDIO
// ============================================================
function registerAudioAsset(audio) {
  assetsTotal++;
  const onLoad = () => {
    assetsLoaded++;
    audio.removeEventListener('canplaythrough', onLoad);
    audio.removeEventListener('error', onError);
  };
  const onError = () => {
    console.error('Failed to load audio asset:', audio.src);
    failedAssets.push(audio.src);
    assetsLoaded++;
    audio.removeEventListener('canplaythrough', onLoad);
    audio.removeEventListener('error', onError);
  };
  audio.addEventListener('canplaythrough', onLoad);
  audio.addEventListener('error', onError);
  audio.preload = 'auto';
  audio.load();
}

const jumpSound = new Audio('/sounds/jump.mp3');
jumpSound.volume = 1.0;
registerAudioAsset(jumpSound);

const bgMusic = new Audio('/sounds/bg.mp3');
bgMusic.volume = 0.6; // 60% default volume
bgMusic.loop = true;
registerAudioAsset(bgMusic);

// ============================================================
//  SETTINGS (localStorage)
// ============================================================
let sfxEnabled = localStorage.getItem('bonerunner_sfx') !== 'false';
let musicEnabled = localStorage.getItem('bonerunner_music') !== 'false';

function saveSetting(key, val) {
  localStorage.setItem(key, String(val));
}

function playSfx(audio) {
  if (!sfxEnabled) return;
  audio.currentTime = 0;
  audio.play().catch(() => { });
}

function updateMusic() {
  // Only play music during active gameplay or game over screen
  if (currentState !== STATES.PLAYING && currentState !== STATES.PAUSED && currentState !== STATES.GAME_OVER) {
    bgMusic.pause();
    bgMusic.currentTime = 0; // Rewind to start for next game
    return;
  }

  if (!musicEnabled || currentState === STATES.PAUSED) {
    bgMusic.pause();
  } else {
    bgMusic.play().catch(() => { });
  }
}

// ============================================================
//  GAME VARIABLES
// ============================================================
let animationFrameId;
let score = 0;
let lastTime = 0;
let homeLayout = {}; // Stores calculated Y coordinates for the home screen
let jumpBufferTimer = 0;
const JUMP_BUFFER_TIME = 0.15;
let rotateOverlayVisible = false;
let rotationGraceActive = false;
let stateBeforeRotatePause = null;
let spriteScaleFactor = 1;

// Base (unscaled) hitbox dimensions — desktop reference values
const PLAYER_BASE_WIDTH = 52;
const PLAYER_BASE_HEIGHT = 85;
const ENEMY_BASE_HITBOX = {
  minotaur: { w: 50, h: 78 },
  reaper: { w: 46, h: 74 },
  shadow: { w: 46, h: 74 },
  skeleton: { w: 46, h: 74 },
  zombie: { w: 48, h: 76 }
};

// ============================================================
//  SPRITE SCALE CACHE
// ============================================================
const spriteScaleCache = new Map();

function cacheSpriteScale(img, targetHeight) {
  if (!img || !img.src) return;
  const key = img.src + '|' + targetHeight;
  if (spriteScaleCache.has(key)) return;
  const frameW = img.naturalWidth;
  const frameH = img.naturalHeight;
  if (frameW === 0 || frameH === 0) return;
  const scale = targetHeight / frameH;
  spriteScaleCache.set(key, {
    drawW: frameW * scale,
    drawH: targetHeight
  });
}

function getCachedScale(img, targetHeight) {
  const key = img.src + '|' + targetHeight;
  let cached = spriteScaleCache.get(key);
  if (!cached && img.naturalWidth > 0) {
    cacheSpriteScale(img, targetHeight);
    cached = spriteScaleCache.get(key);
  }
  return cached;
}

// ============================================================
//  CHARACTER VISUAL CONFIG
// ============================================================
const CHARACTER_CONFIG = {
  hero: { targetHeight: 270 },
  minotaur: { targetHeight: 235 },
  reaper: { targetHeight: 235 },
  shadow: { targetHeight: 235 },
  skeleton: { targetHeight: 235 },
  zombie: { targetHeight: 245 }
};

// ============================================================
//  SPRITES — Hero
// ============================================================
const sprites = { running: [], jumping: [], falling: [], dying: [] };
const spriteConfig = {
  running: { name: 'Running', frames: 12, speed: 15 },
  jumping: { name: 'Jump Loop', frames: 6, speed: 10 },
  falling: { name: 'Falling Down', frames: 6, speed: 10 },
  dying: { name: 'Dying', frames: 15, speed: 15 }
};

const basePath = '/Characters/Forest_Ranger_1/PNG/PNG Sequences';
for (const [key, anim] of Object.entries(spriteConfig)) {
  for (let i = 0; i < anim.frames; i++) {
    const img = new Image();
    const num = i.toString().padStart(3, '0');
    assetsTotal++;
    img.src = encodeURI(`${basePath}/${anim.name}/0_Forest_Ranger_${anim.name}_${num}.png`);
    img.onload = () => {
      cacheSpriteScale(img, CHARACTER_CONFIG.hero.targetHeight);
      assetsLoaded++;
    };
    img.onerror = () => {
      console.error('Failed to load image asset:', img.src);
      failedAssets.push(img.src);
      assetsLoaded++;
    };
    sprites[key].push(img);
  }
}

// ============================================================
//  SPRITES — Villains
// ============================================================
const villainTypes = ['minotaur', 'reaper', 'shadow', 'skeleton', 'zombie'];
const villainSpriteConfig = {
  minotaur: {
    basePath: '/Characters/Minotaur_1/PNG/PNG Sequences/Running',
    prefix: '0_Minotaur_Running',
    frames: 12
  },
  reaper: {
    basePath: '/Characters/Reaper_Man_1/PNG/PNG Sequences/Running',
    prefix: '0_Reaper_Man_Running',
    frames: 12
  },
  shadow: {
    basePath: '/Characters/Necromancer_of_the_Shadow_1/PNG/PNG Sequences/Running',
    prefix: '0_Necromancer_of_the_Shadow_Running',
    frames: 12
  },
  skeleton: {
    basePath: '/Characters/Skeleton_Warrior_1/PNG/PNG Sequences/Running',
    prefix: '0_Skeleton_Warrior_Running',
    frames: 12
  },
  zombie: {
    basePath: '/Characters/Zombie_Villager_1/PNG/PNG Sequences/Running',
    prefix: '0_Zombie_Villager_Running',
    frames: 12
  }
};

const obstacleSprites = {};
for (const type of villainTypes) {
  obstacleSprites[type] = [];
  const vConf = villainSpriteConfig[type];
  const targetH = CHARACTER_CONFIG[type].targetHeight;
  for (let i = 0; i < vConf.frames; i++) {
    const img = new Image();
    const num = i.toString().padStart(3, '0');
    assetsTotal++;
    img.src = encodeURI(`${vConf.basePath}/${vConf.prefix}_${num}.png`);
    img.onload = () => {
      cacheSpriteScale(img, targetH);
      assetsLoaded++;
    };
    img.onerror = () => {
      console.error('Failed to load image asset:', img.src);
      failedAssets.push(img.src);
      assetsLoaded++;
    };
    obstacleSprites[type].push(img);
  }
}

// ============================================================
//  BACKGROUND
// ============================================================
const staticBg = new Image();
assetsTotal++;
staticBg.src = encodeURI('/PNG/4/dead forest.png');
staticBg.onload = () => { bgCacheDirty = true; assetsLoaded++; };
staticBg.onerror = () => {
  console.error('Failed to load image asset:', staticBg.src);
  failedAssets.push(staticBg.src);
  assetsLoaded++;
};

const fhcLogo = new Image();
assetsTotal++;
fhcLogo.src = '/fhc.png';
fhcLogo.onload = () => { assetsLoaded++; };
fhcLogo.onerror = () => { console.error('Failed to load fhc logo'); assetsLoaded++; };
let bgDrawData = { drawWidth: 0, drawHeight: 0, dx: 0, dy: 0, scale: 1 };
let bgCacheCanvas = null;
let bgCacheDirty = true;

function rebuildBgCache() {
  if (!staticBg.complete || bgDrawData.drawWidth === 0) return;
  if (!bgCacheCanvas) {
    bgCacheCanvas = document.createElement('canvas');
  }
  bgCacheCanvas.width = canvas.width;
  bgCacheCanvas.height = canvas.height;
  const bgCtx = bgCacheCanvas.getContext('2d');
  bgCtx.fillStyle = '#050510';
  bgCtx.fillRect(0, 0, bgCacheCanvas.width, bgCacheCanvas.height);
  bgCtx.drawImage(staticBg, bgDrawData.dx, bgDrawData.dy, bgDrawData.drawWidth, bgDrawData.drawHeight);
  bgCacheDirty = false;
}


// ============================================================
//  GAME CONFIG
// ============================================================
const config = {
  gravity: 1500,
  jumpVelocity: -700,
  groundHeight: 50,
  speed: 400
};
Object.freeze(config);

// ============================================================
//  PLAYER
// ============================================================
const player = {
  x: 50,
  y: 0,
  width: PLAYER_BASE_WIDTH,
  height: PLAYER_BASE_HEIGHT,
  velocity_y: 0,
  isGrounded: false,
  animState: 'running',
  animFrame: 0,
  animTimer: 0
};

// ============================================================
//  OBSTACLES
// ============================================================
let obstacles = [];
const obstacleConfig = {
  spawnIntervalMin: 1000,
  spawnIntervalMax: 2000,
  timeSinceLastSpawn: 0,
  nextSpawnTime: 1500
};

const enemyConfig = {
  minotaur: { hitboxWidth: 50, hitboxHeight: 78 },
  reaper: { hitboxWidth: 46, hitboxHeight: 74 },
  shadow: { hitboxWidth: 46, hitboxHeight: 74 },
  skeleton: { hitboxWidth: 46, hitboxHeight: 74 },
  zombie: { hitboxWidth: 48, hitboxHeight: 76 }
};

// ============================================================
//  PARTICLES
// ============================================================
let particles = [];

// ============================================================
//  UI SYSTEM
// ============================================================

// --- UIButton ---
class UIButton {
  constructor(text, x, y, w, h, callback, options = {}) {
    this.text = text;
    this.x = x;
    this.y = y;
    this.width = w;
    this.height = h;
    this.callback = callback;
    this.state = 'idle'; // idle, hover, pressed, disabled
    this.fillColor = options.fillColor || THEME.darkBrown;
    this.hoverColor = options.hoverColor || THEME.darkBrownHover;
    this.pressedColor = options.pressedColor || THEME.darkBrownPressed;
    this.textColor = options.textColor || THEME.boneWhite;
    this.fontSize = options.fontSize || 18;
    this.borderRadius = options.borderRadius || 10;
    this.small = options.small || false;
    this.pauseIcon = options.pauseIcon || false;
    this.fsIcon = options.fsIcon || false; // 'expand' | 'contract'
  }

  contains(px, py) {
    return px >= this.x && px <= this.x + this.width &&
      py >= this.y && py <= this.y + this.height;
  }

  draw(ctx) {
    ctx.save();

    let fill = this.fillColor;
    let scaleAmt = 1;
    if (this.state === 'disabled') {
      fill = 'rgba(60,40,30,0.5)';
    } else if (this.state === 'pressed') {
      fill = this.pressedColor;
      scaleAmt = 0.95;
    } else if (this.state === 'hover') {
      fill = this.hoverColor;
    }

    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;

    if (scaleAmt !== 1) {
      ctx.translate(cx, cy);
      ctx.scale(scaleAmt, scaleAmt);
      ctx.translate(-cx, -cy);
    }

    // Hover glow
    if (this.state === 'hover') {
      ctx.shadowColor = THEME.pumpkinOrange;
      ctx.shadowBlur = 15;
    }

    // Button body
    drawRoundedRect(ctx, this.x, this.y, this.width, this.height, this.borderRadius, fill);

    // Border
    ctx.shadowBlur = 0;
    ctx.strokeStyle = THEME.borderLight;
    ctx.lineWidth = 1.5;
    strokeRoundedRect(ctx, this.x, this.y, this.width, this.height, this.borderRadius);

    const iconColor = this.state === 'disabled' ? 'rgba(244,241,232,0.35)' : this.textColor;

    if (this.pauseIcon) {
      // Draw two filled rect bars (pause icon)
      const bw = Math.max(3, this.width * 0.16);
      const bh = Math.max(8, this.height * 0.42);
      const gap = Math.max(3, this.width * 0.1);
      const bx1 = cx - gap / 2 - bw;
      const by1 = cy - bh / 2;
      ctx.fillStyle = iconColor;
      ctx.shadowColor = THEME.textShadow;
      ctx.shadowBlur = 3;
      ctx.fillRect(bx1, by1, bw, bh);
      ctx.fillRect(bx1 + bw + gap, by1, bw, bh);
    } else if (this.fsIcon) {
      // Fullscreen expand/contract icon
      const pad = Math.round(this.width * 0.25);
      const arm = Math.round(this.width * 0.2);
      ctx.strokeStyle = iconColor;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = THEME.textShadow;
      ctx.shadowBlur = 3;
      
      ctx.beginPath();
      if (this.fsIcon === 'expand') {
        // Top-left
        ctx.moveTo(cx - pad, cy - pad + arm);
        ctx.lineTo(cx - pad, cy - pad);
        ctx.lineTo(cx - pad + arm, cy - pad);
        // Top-right
        ctx.moveTo(cx + pad - arm, cy - pad);
        ctx.lineTo(cx + pad, cy - pad);
        ctx.lineTo(cx + pad, cy - pad + arm);
        // Bottom-right
        ctx.moveTo(cx + pad, cy + pad - arm);
        ctx.lineTo(cx + pad, cy + pad);
        ctx.lineTo(cx + pad - arm, cy + pad);
        // Bottom-left
        ctx.moveTo(cx - pad + arm, cy + pad);
        ctx.lineTo(cx - pad, cy + pad);
        ctx.lineTo(cx - pad, cy + pad - arm);
      } else {
        // Contract (point inwards)
        const inPad = Math.round(this.width * 0.1);
        // Top-left
        ctx.moveTo(cx - inPad, cy - inPad - arm);
        ctx.lineTo(cx - inPad, cy - inPad);
        ctx.lineTo(cx - inPad - arm, cy - inPad);
        // Top-right
        ctx.moveTo(cx + inPad + arm, cy - inPad);
        ctx.lineTo(cx + inPad, cy - inPad);
        ctx.lineTo(cx + inPad, cy - inPad - arm);
        // Bottom-right
        ctx.moveTo(cx + inPad, cy + inPad + arm);
        ctx.lineTo(cx + inPad, cy + inPad);
        ctx.lineTo(cx + inPad + arm, cy + inPad);
        // Bottom-left
        ctx.moveTo(cx - inPad - arm, cy + inPad);
        ctx.lineTo(cx - inPad, cy + inPad);
        ctx.lineTo(cx - inPad, cy + inPad + arm);
      }
      ctx.stroke();
    } else {
      // Text
      ctx.fillStyle = iconColor;
      ctx.font = `600 ${this.fontSize}px ${FONT.body}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = THEME.textShadow;
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 2;
      ctx.fillText(this.text, cx, cy);
    }

    ctx.restore();
  }
}

// --- UIPanel ---
class UIPanel {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.width = w;
    this.height = h;
    this.animAlpha = 0;
    this.animScale = 0.85;
    this.animStartTime = 0;
    this.animDuration = 300; // ms
    this.animating = true;
  }

  startAnimation() {
    this.animAlpha = 0;
    this.animScale = 0.85;
    this.animStartTime = performance.now();
    this.animating = true;
  }

  updateAnimation() {
    if (!this.animating) return;
    const elapsed = performance.now() - this.animStartTime;
    const t = Math.min(elapsed / this.animDuration, 1);
    const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
    this.animAlpha = ease;
    this.animScale = 0.85 + 0.15 * ease;
    if (t >= 1) {
      this.animating = false;
      this.animAlpha = 1;
      this.animScale = 1;
    }
  }

  draw(ctx, drawContent) {
    this.updateAnimation();

    ctx.save();
    ctx.globalAlpha = this.animAlpha;

    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;

    ctx.translate(cx, cy);
    ctx.scale(this.animScale, this.animScale);
    ctx.translate(-cx, -cy);

    // Panel background
    drawRoundedRect(ctx, this.x, this.y, this.width, this.height, 14, THEME.deepPurple);

    // Panel border
    ctx.strokeStyle = THEME.borderMedium;
    ctx.lineWidth = 1.5;
    strokeRoundedRect(ctx, this.x, this.y, this.width, this.height, 14);

    // Draw content callback
    if (drawContent) drawContent(ctx);

    ctx.restore();
  }
}

// --- Drawing Helpers ---
function drawRoundedRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.stroke();
}

function drawDivider(ctx, x, y, w) {
  const grad = ctx.createLinearGradient(x, y, x + w, y);
  grad.addColorStop(0, 'rgba(244,241,232,0)');
  grad.addColorStop(0.3, 'rgba(244,241,232,0.2)');
  grad.addColorStop(0.5, 'rgba(244,241,232,0.3)');
  grad.addColorStop(0.7, 'rgba(244,241,232,0.2)');
  grad.addColorStop(1, 'rgba(244,241,232,0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
}

// ============================================================
//  UI MANAGER
// ============================================================
let activeButtons = [];
let activePanel = null;
let hoveredButton = null;

// Screen-specific data
let resetConfirmActive = false;
let leaderboardReturnState = STATES.HOME;
let leaderboardData = null;
let leaderboardLoading = false;
let playerRankData = null;

function buildHomeButtons() {
  activeButtons = [];
  activePanel = null;

  const cw = canvas.width;
  const ch = canvas.height;

  // Fullscreen toggle (top right)
  const fsSize = 42;
  const fsMargin = 16;
  const fsIconType = typeof isFullscreen !== 'undefined' && isFullscreen() ? 'contract' : 'expand';
  activeButtons.push(new UIButton('', cw - fsSize - fsMargin, fsMargin, fsSize, fsSize, () => {
    playSfx(jumpSound);
    toggleFullscreen();
  }, {
    borderRadius: 21, small: true,
    fillColor: 'rgba(13,13,13,0.45)',
    hoverColor: 'rgba(143,209,79,0.25)',
    pressedColor: 'rgba(143,209,79,0.35)',
    fsIcon: fsIconType
  }));

  // Info toggle (left of fullscreen)
  activeButtons.push(new UIButton('?', cw - (fsSize * 2) - (fsMargin * 2), fsMargin, fsSize, fsSize, () => {
    playSfx(jumpSound);
    showInfoOverlay();
  }, {
    borderRadius: 21, small: true, fontSize: 24,
    fillColor: 'rgba(13,13,13,0.45)',
    hoverColor: 'rgba(143,209,79,0.25)',
    pressedColor: 'rgba(143,209,79,0.35)',
    textColor: THEME.boneWhite
  }));

  // Logout toggle (left of info)
  activeButtons.push(new UIButton('Log Out', cw - (fsSize * 2) - (fsMargin * 3) - 85, fsMargin, 85, fsSize, () => {
    playSfx(jumpSound);
    if (confirm('Are you sure you want to log out?')) {
      localStorage.removeItem('bonerunner_player_id');
      localStorage.removeItem('bonerunner_player_name');
      score = 0;
      switchState(STATES.REGISTER);
    }
  }, {
    borderRadius: 21, small: true, fontSize: 14,
    fillColor: 'rgba(13,13,13,0.45)',
    hoverColor: 'rgba(232,67,47,0.25)',
    pressedColor: 'rgba(232,67,47,0.35)',
    textColor: THEME.boneWhite
  }));

  const btnW = Math.min(240, cw * 0.5);
  const btnH = 52;
  const gap = 14;

  // --- Dynamic Centering Layout ---
  const playerName = localStorage.getItem('bonerunner_player_name');
  
  // Calculate relative heights assuming title is at 0
  let currentY = 0;
  
  const badgeRelative = currentY - 36;
  const titleRelative = currentY;
  currentY += 42;
  const subtitleRelative = currentY;
  
  let welcomeRelative = 0;
  if (playerName) {
    currentY += 22;
    welcomeRelative = currentY;
  }
  
  // Padding before buttons
  currentY += 48;
  const buttonsStartYRelative = currentY;
  
  // Total buttons height
  const buttonsHeight = 3 * btnH + 2 * gap; // Play, Leaderboard, Settings
  currentY += buttonsHeight;
  
  // Padding before countdown
  currentY += 32;
  const countdownRelative = currentY;
  
  const totalStackHeight = countdownRelative - badgeRelative;
  
  // Center the stack vertically in `ch`
  const stackTop = (ch - totalStackHeight) / 2;
  const offsetY = stackTop - badgeRelative; // Amount to shift everything down
  
  homeLayout.badgeY = badgeRelative + offsetY;
  homeLayout.titleY = titleRelative + offsetY;
  homeLayout.subtitleY = subtitleRelative + offsetY;
  homeLayout.welcomeY = playerName ? welcomeRelative + offsetY : 0;
  homeLayout.countdownY = countdownRelative + offsetY;
  
  const startX = cw / 2 - btnW / 2;
  const startY = buttonsStartYRelative + offsetY;

  const playBtn = new UIButton('Play', startX, startY, btnW, btnH, () => {
    playSfx(jumpSound);
    resetGame();

    if (isMobile()) {
      // Enter fullscreen and request landscape lock
      requestFullscreenAndLock();

      // Start game immediately but activate grace period
      rotationGraceActive = true;
      rotateOverlayVisible = false;
      switchState(STATES.PLAYING);

      // After ~1 second, check if we're still in portrait
      setTimeout(() => {
        rotationGraceActive = false;
        if (isMobile() && !isLandscape()) {
          // Browser didn't auto-rotate — show overlay and pause
          rotateOverlayVisible = true;
          if (currentState === STATES.PLAYING) {
            stateBeforeRotatePause = STATES.PLAYING;
            switchState(STATES.PAUSED);
          }
        }
      }, 1000);
    } else {
      bgMusic.play().catch(() => {});
      switchState(STATES.PLAYING);
    }
  });

  if (isDeadlinePassed()) {
    playBtn.state = 'disabled';
    playBtn.text = 'Event Ended';
    playBtn.callback = () => {};
  }
  activeButtons.push(playBtn);

  activeButtons.push(new UIButton('Leaderboard', startX, startY + btnH + gap, btnW, btnH, () => {
    playSfx(jumpSound);
    leaderboardReturnState = STATES.HOME;
    switchState(STATES.LEADERBOARD);
  }));

  activeButtons.push(new UIButton('Settings', startX, startY + 2 * (btnH + gap), btnW, btnH, () => {
    playSfx(jumpSound);
    switchState(STATES.SETTINGS);
  }));
}

function buildPlayingButtons() {
  activeButtons = [];
  activePanel = null;

  const size = 42;
  const margin = 16;
  const safeTop = safeArea.top;
  const safeRight = safeArea.right;

  // Pause button — top right
  activeButtons.push(new UIButton('', canvas.width - size - margin - safeRight, margin + safeTop, size, size, () => {
    playSfx(jumpSound);
    switchState(STATES.PAUSED);
  }, { borderRadius: 8, small: true, pauseIcon: true }));

  // Fullscreen button - beside Pause
  const playFsIcon = typeof isFullscreen !== 'undefined' && isFullscreen() ? 'contract' : 'expand';
  activeButtons.push(new UIButton('', canvas.width - size * 2 - margin * 2 - safeRight, margin + safeTop, size, size, () => {
    playSfx(jumpSound);
    toggleFullscreen();
  }, {
    borderRadius: 21, small: true,
    fillColor: 'rgba(26,26,46,0.45)',
    hoverColor: 'rgba(232,115,42,0.25)',
    pressedColor: 'rgba(232,115,42,0.35)',
    fsIcon: playFsIcon
  }));
}

function buildPauseButtons() {
  activeButtons = [];

  const cw = canvas.width;
  const ch = canvas.height;
  const panelW = Math.min(320, cw * 0.6);
  const panelH = 280;
  const px = (cw - panelW) / 2;
  const py = (ch - panelH) / 2;

  activePanel = new UIPanel(px, py, panelW, panelH);
  activePanel.startAnimation();

  const btnW = panelW - 60;
  const btnH = 48;
  const gap = 12;
  const bx = px + 30;
  const headerH = 70;
  const by = py + headerH;

  activeButtons.push(new UIButton('Resume', bx, by, btnW, btnH, () => {
    playSfx(jumpSound);
    switchState(STATES.PLAYING);
  }));

  activeButtons.push(new UIButton('Restart', bx, by + btnH + gap, btnW, btnH, () => {
    playSfx(jumpSound);
    resetGame();
    switchState(STATES.PLAYING);
  }));

  activeButtons.push(new UIButton('Main Menu', bx, by + 2 * (btnH + gap), btnW, btnH, () => {
    playSfx(jumpSound);
    switchState(STATES.HOME);
  }));
}

function buildGameOverButtons() {
  activeButtons = [];

  const cw = canvas.width;
  const ch = canvas.height;
  const panelW = Math.min(340, cw * 0.65);
  const panelH = 340;
  const px = (cw - panelW) / 2;
  const py = (ch - panelH) / 2;

  activePanel = new UIPanel(px, py, panelW, panelH);
  activePanel.startAnimation();

  const btnW = panelW - 60;
  const btnH = 48;
  const gap = 12;
  const bx = px + 30;
  const by = py + panelH - 30 - 2 * btnH - gap;

  activeButtons.push(new UIButton('Play Again', bx, by, btnW, btnH, () => {
    playSfx(jumpSound);
    resetGame();
    switchState(STATES.PLAYING);
  }));

  activeButtons.push(new UIButton('Main Menu', bx, by + btnH + gap, btnW, btnH, () => {
    playSfx(jumpSound);
    switchState(STATES.HOME);
  }));
}

function buildLeaderboardButtons() {
  activeButtons = [];

  const cw = canvas.width;
  const ch = canvas.height;
  const panelW = Math.min(360, cw * 0.7);
  const rankRowHeight = 44;
  const rankGap = 14; // breathing room above and below rank band
  const panelH = 280 + rankRowHeight + rankGap * 2;
  const px = (cw - panelW) / 2;
  const py = (ch - panelH) / 2;

  activePanel = new UIPanel(px, py, panelW, panelH);
  activePanel.startAnimation();

  const btnW = panelW - 60;
  const btnH = 48;
  const bx = px + 30;
  const by = py + panelH - 30 - btnH;

  activeButtons.push(new UIButton('Back', bx, by, btnW, btnH, () => {
    playSfx(jumpSound);
    switchState(leaderboardReturnState);
  }));
}

function buildSettingsButtons() {
  activeButtons = [];
  resetConfirmActive = false;

  const cw = canvas.width;
  const ch = canvas.height;
  const panelW = Math.min(360, cw * 0.7);
  const panelH = 260;
  const px = (cw - panelW) / 2;
  const py = (ch - panelH) / 2;

  activePanel = new UIPanel(px, py, panelW, panelH);
  activePanel.startAnimation();

  const btnW = panelW - 60;
  const btnH = 44;
  const gap = 10;
  const bx = px + 30;
  const headerH = 65;

  // Music toggle
  const musicBtn = new UIButton(
    musicEnabled ? 'Music: ON' : 'Music: OFF',
    bx, py + headerH, btnW, btnH,
    () => {
      playSfx(jumpSound);
      musicEnabled = !musicEnabled;
      saveSetting('bonerunner_music', musicEnabled);
      musicBtn.text = musicEnabled ? 'Music: ON' : 'Music: OFF';
      musicBtn.fillColor = musicEnabled ? '#2E4A28' : '#4A2828';
      updateMusic();
    },
    { fillColor: musicEnabled ? '#2E4A28' : '#4A2828' }
  );
  activeButtons.push(musicBtn);

  // SFX toggle
  const sfxBtn = new UIButton(
    sfxEnabled ? 'Sound Effects: ON' : 'Sound Effects: OFF',
    bx, py + headerH + btnH + gap, btnW, btnH,
    () => {
      sfxEnabled = !sfxEnabled;
      saveSetting('bonerunner_sfx', sfxEnabled);
      sfxBtn.text = sfxEnabled ? 'Sound Effects: ON' : 'Sound Effects: OFF';
      sfxBtn.fillColor = sfxEnabled ? '#2E4A28' : '#4A2828';
      playSfx(jumpSound);
    },
    { fillColor: sfxEnabled ? '#2E4A28' : '#4A2828' }
  );
  activeButtons.push(sfxBtn);

  // Back button
  activeButtons.push(new UIButton('Back', bx, py + panelH - 30 - btnH, btnW, btnH, () => {
    playSfx(jumpSound);
    switchState(STATES.HOME);
  }));
}

// ============================================================
//  SWITCH STATE
// ============================================================
const regOverlay = document.getElementById('registration-overlay');
const infoOverlay = document.getElementById('info-overlay');

function showInfoOverlay() {
  if (infoOverlay) infoOverlay.classList.remove('hidden');
  localStorage.setItem('bonerunner_info_seen', 'true');
}

function hideInfoOverlay() {
  if (infoOverlay) infoOverlay.classList.add('hidden');
  if (currentState === STATES.REGISTER) {
    if (regOverlay) regOverlay.classList.remove('hidden');
  }
}

async function switchState(newState) {
  previousState = currentState;
  currentState = newState;
  hoveredButton = null;

  if (newState !== STATES.REGISTER && regOverlay) {
    regOverlay.classList.add('hidden');
  }

  switch (newState) {
    case STATES.REGISTER:
      if (!localStorage.getItem('bonerunner_info_seen')) {
        showInfoOverlay();
      } else {
        if (regOverlay) regOverlay.classList.remove('hidden');
      }
      break;
    case STATES.HOME:
      cancelAnimationFrame(animationFrameId);
      buildHomeButtons();
      drawFrame(); // single frame
      if (!localStorage.getItem('bonerunner_info_seen')) {
        showInfoOverlay();
      }
      break;
    case STATES.PLAYING:
      buildPlayingButtons();
      lastTime = performance.now();
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(gameLoop);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(async () => {
        if (currentSessionId) {
          const { error } = await supabase.rpc('send_heartbeat', {
            p_session_id: currentSessionId,
            p_jumps_made: sessionStats.jumps,
            p_obstacles_dodged: sessionStats.dodges
          });
          if (error) { /* heartbeat failed silently */ }
        }
      }, 5000);
      break;
    case STATES.PAUSED:
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      buildPauseButtons();
      break;
    case STATES.GAME_OVER:
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (currentSessionId) {
        try {
          const endParams = {
            p_session_id: currentSessionId,
            p_client_score: Math.floor(score),
            p_jumps_made: sessionStats.jumps,
            p_obstacles_dodged: sessionStats.dodges
          };
          // Include nonce if available (anti-replay)
          if (currentSessionNonce) {
            endParams.p_nonce = currentSessionNonce;
          }
          const { data: serverScore, error: endError } = await supabase.rpc('end_game_session', endParams);
          if (!endError && serverScore !== null && serverScore !== undefined) {
            // Use the server-authoritative score instead of client score
            score = serverScore;
          }
        } catch (_) {
          // Score submission failed — client score stands for display only
        }
        currentSessionId = null;
        currentSessionNonce = null;
      }
      buildGameOverButtons();
      break;
    case STATES.LEADERBOARD:
      leaderboardScrollY = 0; // Reset scroll on open
      buildLeaderboardButtons();
      if (previousState === STATES.HOME) drawFrame();
      leaderboardLoading = true;
      leaderboardData = null;
      playerRankData = null;
      const playerId = localStorage.getItem('bonerunner_player_id');
      Promise.all([
        getTopPlayers(),
        getPlayerRank(playerId)
      ]).then(([topData, rankData]) => {
        leaderboardData = topData;
        playerRankData = rankData;
        leaderboardLoading = false;
      }).catch(() => { leaderboardLoading = false; });
      break;
    case STATES.SETTINGS:
      buildSettingsButtons();
      if (previousState === STATES.HOME) drawFrame();
      break;
  }

  updateMusic();
}

// ============================================================
//  RESIZE
// ============================================================
function resize() {
  const appEl = document.getElementById('app');
  const rect = appEl.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const rootStyle = getComputedStyle(document.documentElement);
  safeArea.left = parseInt(rootStyle.getPropertyValue('--safe-left')) || 0;
  safeArea.right = parseInt(rootStyle.getPropertyValue('--safe-right')) || 0;
  safeArea.top = parseInt(rootStyle.getPropertyValue('--safe-top')) || 0;

  const imgRatio = 3840 / 2160;
  const canvasRatio = canvas.width / canvas.height;

  let drawWidth, drawHeight, offsetX, offsetY;

  if (imgRatio > canvasRatio) {
    drawHeight = canvas.height;
    drawWidth = drawHeight * imgRatio;
    offsetX = (canvas.width - drawWidth) / 2;
    offsetY = 0;
  } else {
    drawWidth = canvas.width;
    drawHeight = drawWidth / imgRatio;
    offsetX = 0;
    offsetY = (canvas.height - drawHeight) / 2;
  }

  bgDrawData.drawWidth = drawWidth;
  bgDrawData.drawHeight = drawHeight;
  bgDrawData.dx = offsetX;
  bgDrawData.dy = offsetY;
  bgDrawData.scale = drawHeight / 2160;
  bgCacheDirty = true;

  config.groundHeight = canvas.height - (bgDrawData.dy + bgDrawData.drawHeight - 380 * bgDrawData.scale);

  // Compute responsive sprite scale based on the shorter screen dimension
  const shortSide = Math.min(canvas.width, canvas.height);
  if (shortSide >= 800) {
    spriteScaleFactor = 1.0;   // Desktop / large tablet
  } else if (shortSide >= 500) {
    spriteScaleFactor = 0.9;   // Tablet
  } else {
    spriteScaleFactor = 0.75;  // Phone
  }

  // Apply scale to player hitbox
  player.width = Math.round(PLAYER_BASE_WIDTH * spriteScaleFactor);
  player.height = Math.round(PLAYER_BASE_HEIGHT * spriteScaleFactor);

  player.x = canvas.width * 0.15;

  if (player.isGrounded) {
    player.y = canvas.height - config.groundHeight - player.height;
  }

  // Rebuild UI buttons for current state
  switch (currentState) {
    case STATES.HOME: buildHomeButtons(); break;
    case STATES.PLAYING: buildPlayingButtons(); break;
    case STATES.PAUSED: buildPauseButtons(); break;
    case STATES.GAME_OVER: buildGameOverButtons(); break;
    case STATES.LEADERBOARD: buildLeaderboardButtons(); break;
    case STATES.SETTINGS: buildSettingsButtons(); break;
  }
}

function isLandscape() {
  return window.matchMedia("(orientation: landscape)").matches;
}

function isMobile() {
  return /Mobi|Android/i.test(navigator.userAgent) || ('ontouchstart' in document.documentElement);
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function requestFullscreenAndLock() {
  const doc = document.documentElement;
  try {
    if (doc.requestFullscreen) {
      await doc.requestFullscreen();
    } else if (doc.webkitRequestFullscreen) {
      await doc.webkitRequestFullscreen();
    }
  } catch (err) {
    console.warn("Fullscreen request failed:", err);
  }

  if (screen.orientation && screen.orientation.lock) {
    try {
      await screen.orientation.lock('landscape');
    } catch (err) {
      console.warn("Orientation lock failed:", err);
    }
  }
}

async function exitFullscreen() {
  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      await document.webkitExitFullscreen();
    }
  } catch (err) {
    console.warn("Exit fullscreen failed:", err);
  }
}

function toggleFullscreen() {
  if (isFullscreen()) {
    exitFullscreen();
  } else {
    requestFullscreenAndLock();
  }
}

document.addEventListener('fullscreenchange', () => {
  resize();
  if (currentState !== STATES.PLAYING && currentState !== STATES.GAME_OVER) {
    drawFrame();
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  resize();
  if (currentState !== STATES.PLAYING && currentState !== STATES.GAME_OVER) {
    drawFrame();
  }
});

// ============================================================
//  INPUT HANDLING
// ============================================================
function executeJump() {
  player.velocity_y = config.jumpVelocity;
  player.isGrounded = false;
  jumpBufferTimer = 0;
  sessionStats.jumps++;
  setTimeout(() => playSfx(jumpSound), 0);
  createParticles(player.x + player.width / 2, player.y + player.height, '#fff', 10);
}

function jump() {
  if (currentState !== STATES.PLAYING) return;
  if (player.isGrounded) {
    executeJump();
  } else {
    jumpBufferTimer = JUMP_BUFFER_TIME;
  }
}

let pointerDown = false;
let pointerDownButton = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!e.isTrusted) return;
  e.preventDefault();
  if (rotateOverlayVisible) return;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);

  pointerDown = true;
  pointerDownButton = null;

  for (let i = 0; i < activeButtons.length; i++) {
    const btn = activeButtons[i];
    if (btn.state !== 'disabled' && btn.contains(px, py)) {
      btn.state = 'pressed';
      pointerDownButton = btn;
      return;
    }
  }

  // Handle Leaderboard Drag to Scroll
  if (currentState === STATES.LEADERBOARD && activePanel) {
    const rx = px - activePanel.x;
    const ry = py - activePanel.y;
    if (rx >= 0 && rx <= activePanel.width && ry >= 95 && ry <= activePanel.height - 78) {
      isDragging = true;
      dragStartY = py;
      dragStartScrollY = leaderboardScrollY;
      return;
    }
  }

  // No button hit — jump if playing
  if (currentState === STATES.PLAYING) {
    jump();
  }
});

canvas.addEventListener('pointerup', (e) => {
  e.preventDefault();
  if (rotateOverlayVisible) return;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);

  pointerDown = false;
  isDragging = false;

  if (pointerDownButton) {
    if (pointerDownButton.contains(px, py) && pointerDownButton.state !== 'disabled') {
      pointerDownButton.callback();
    }
    pointerDownButton.state = 'idle';
    pointerDownButton = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (rotateOverlayVisible) return;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);

  // Handle Leaderboard Scrolling
  if (isDragging && currentState === STATES.LEADERBOARD) {
    const deltaY = dragStartY - py;
    leaderboardScrollY = Math.max(0, Math.min(dragStartScrollY + deltaY, leaderboardMaxScroll));
    return;
  }

  // Reset previous hover
  if (hoveredButton && hoveredButton !== pointerDownButton) {
    hoveredButton.state = 'idle';
    hoveredButton = null;
  }

  if (!pointerDown) {
    for (let i = 0; i < activeButtons.length; i++) {
      const btn = activeButtons[i];
      if (btn.state !== 'disabled' && btn.contains(px, py)) {
        btn.state = 'hover';
        hoveredButton = btn;
        return;
      }
    }
  }
});

canvas.addEventListener('pointerleave', () => {
  if (hoveredButton) {
    hoveredButton.state = 'idle';
    hoveredButton = null;
  }
});

// Mobile / Touch / Mouse Input
window.addEventListener('touchstart', (e) => {
  if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    jump();
  }
}, { passive: false });

window.addEventListener('mousedown', (e) => {
  if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    jump();
  }
});

// Keyboard Input
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return;
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();
    jump();
  }
  if (e.code === 'Escape') {
    if (currentState === STATES.PLAYING) {
      switchState(STATES.PAUSED);
    } else if (currentState === STATES.PAUSED) {
      switchState(STATES.PLAYING);
    }
  }
});

function handleOrientationResize() {
  resize();

  if (!isMobile()) {
    if (currentState !== STATES.PLAYING && currentState !== STATES.GAME_OVER) {
      drawFrame();
    }
    return;
  }

  // During the grace period, don't show/hide the overlay — let the timer handle it
  if (rotationGraceActive) {
    if (isLandscape()) {
      // Browser rotated within the grace window — all good, cancel the grace
      rotationGraceActive = false;
      rotateOverlayVisible = false;
    }
    if (currentState !== STATES.PLAYING && currentState !== STATES.GAME_OVER) {
      drawFrame();
    }
    return;
  }

  if (isLandscape()) {
    // Landscape restored — hide overlay and auto-resume
    if (rotateOverlayVisible) {
      rotateOverlayVisible = false;
      if (currentState === STATES.PAUSED && stateBeforeRotatePause === STATES.PLAYING) {
        stateBeforeRotatePause = null;
        switchState(STATES.PLAYING);
      }
    }
  } else {
    // Rotated to portrait during gameplay — pause and show overlay
    if (!rotateOverlayVisible && currentState === STATES.PLAYING) {
      rotateOverlayVisible = true;
      stateBeforeRotatePause = STATES.PLAYING;
      switchState(STATES.PAUSED);
    } else if (!rotateOverlayVisible && (currentState === STATES.PAUSED || currentState === STATES.GAME_OVER)) {
      rotateOverlayVisible = true;
    }
  }

  if (currentState !== STATES.PLAYING && currentState !== STATES.GAME_OVER) {
    drawFrame();
  }
}

window.addEventListener('resize', handleOrientationResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleOrientationResize);
}

window.addEventListener('orientationchange', () => {
  setTimeout(handleOrientationResize, 100);
});

// ============================================================
//  GAME LOGIC (unchanged)
// ============================================================
async function resetGame() {
  score = 0;
  obstacles = [];
  particles = [];
  speedMultiplier = 1;
  player.y = canvas.height - config.groundHeight - player.height;
  player.velocity_y = 0;
  player.isGrounded = true;
  player.animState = 'running';
  player.animFrame = 0;
  player.animTimer = 0;
  jumpBufferTimer = 0;
  obstacleConfig.timeSinceLastSpawn = 0;
  lastTime = performance.now();
  sessionStats = { jumps: 0, dodges: 0 };

  const { data: sessionData, error: startError } = await supabase.rpc('start_game_session', {
    p_player_id: localStorage.getItem('bonerunner_player_id')
  });
  if (startError) {
    // Session start failed — game will run locally without score tracking
  } else {
    // start_game_session now returns JSON: { session_id, nonce }
    if (sessionData && typeof sessionData === 'object') {
      currentSessionId = sessionData.session_id;
      currentSessionNonce = sessionData.nonce;
    } else {
      // Fallback for old function signature (returns UUID directly)
      currentSessionId = sessionData;
      currentSessionNonce = null;
    }
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(async () => {
      if (currentSessionId) {
        const { error } = await supabase.rpc('send_heartbeat', {
          p_session_id: currentSessionId,
          p_jumps_made: sessionStats.jumps,
          p_obstacles_dodged: sessionStats.dodges
        });
        if (error) { /* heartbeat failed silently */ }
      }
    }, 5000);
  }
}

function spawnObstacle() {
  const type = villainTypes[Math.floor(Math.random() * villainTypes.length)];
  const base = ENEMY_BASE_HITBOX[type];
  const scaledW = Math.round(base.w * spriteScaleFactor);
  const scaledH = Math.round(base.h * spriteScaleFactor);

  obstacles.push({
    x: canvas.width,
    y: canvas.height - config.groundHeight - scaledH,
    width: scaledW,
    height: scaledH,
    type: type,
    animFrame: 0,
    animTimer: 0
  });
}

function createParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 200,
      vy: (Math.random() - 0.5) * 200,
      life: 1,
      color
    });
  }
}

function checkCollision(rect1, rect2) {
  return rect1.x < rect2.x + rect2.width &&
    rect1.x + rect1.width > rect2.x &&
    rect1.y < rect2.y + rect2.height &&
    rect1.y + rect1.height > rect2.y;
}

function update(dt) {
  if (currentState === STATES.GAME_OVER) {
    if (player.animState !== 'dying') {
      player.animState = 'dying';
      player.animFrame = 0;
      player.animTimer = 0;
    }
    const aConf = spriteConfig.dying;
    player.animTimer += dt;
    if (player.animTimer > 1 / aConf.speed) {
      player.animTimer = 0;
      player.animFrame = (player.animFrame + 1);
      if (player.animFrame >= aConf.frames) {
        player.animFrame = aConf.frames - 1;
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * 2;
      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
    return;
  }

  if (currentState !== STATES.PLAYING) return;

  // Active Anti-Debugging: Execution Timing Check
  // If dt is larger than 0.5s (500ms), it's highly likely they hit a breakpoint in DevTools.
  // We instantly kill the game session.
  if (dt > 0.5) {
    console.warn("Execution pause detected. Session invalidated.");
    switchState(STATES.GAME_OVER);
    return;
  }

  if (jumpBufferTimer > 0) {
    jumpBufferTimer -= dt;
  }

  // Animation State Transition
  let targetAnimState = 'running';
  if (!player.isGrounded) {
    targetAnimState = player.velocity_y < 0 ? 'jumping' : 'falling';
  }
  if (player.animState !== targetAnimState) {
    player.animState = targetAnimState;
    player.animFrame = 0;
    player.animTimer = 0;
  }

  // Animation Update
  const aConf = spriteConfig[player.animState];
  player.animTimer += dt;
  if (player.animTimer > 1 / aConf.speed) {
    player.animTimer = 0;
    player.animFrame = (player.animFrame + 1) % aConf.frames;
  }

  // Score & Difficulty
  score += dt * 10 * speedMultiplier;
  speedMultiplier += dt * 0.01;

  // Player Physics
  const expectedVelocityY = player.velocity_y + config.gravity * dt;
  player.velocity_y = expectedVelocityY;
  player.y += player.velocity_y * dt;

  // Physics Integrity Check
  // If gravity doesn't pull them down, they tampered with the engine.
  if (!player.isGrounded && player.velocity_y < -1000) {
      console.warn("Physics anomaly detected.");
      switchState(STATES.GAME_OVER);
      return;
  }

  // Ground Collision
  const groundY = canvas.height - config.groundHeight;
  if (player.y + player.height >= groundY) {
    player.y = groundY - player.height;
    player.velocity_y = 0;
    player.isGrounded = true;

    if (jumpBufferTimer > 0) {
      executeJump();
    }
  }

  // Obstacles
  obstacleConfig.timeSinceLastSpawn += dt * 1000;
  if (obstacleConfig.timeSinceLastSpawn >= obstacleConfig.nextSpawnTime) {
    spawnObstacle();
    obstacleConfig.timeSinceLastSpawn = 0;
    obstacleConfig.nextSpawnTime = Math.random() * (obstacleConfig.spawnIntervalMax - obstacleConfig.spawnIntervalMin) + obstacleConfig.spawnIntervalMin;
    obstacleConfig.nextSpawnTime /= speedMultiplier;
  }

  const currentSpeed = config.speed * speedMultiplier;

  for (let i = obstacles.length - 1; i >= 0; i--) {
    const obs = obstacles[i];
    obs.x -= currentSpeed * dt;

    obs.animTimer += dt;
    if (obs.animTimer > 1 / 15) {
      obs.animTimer = 0;
      obs.animFrame = (obs.animFrame + 1) % 12;
    }

    if (obs.x + obs.width < 0) {
      sessionStats.dodges++;
      obstacles[i] = obstacles[obstacles.length - 1];
      obstacles.pop();
      continue;
    }

    if (checkCollision(player, obs)) {
      createParticles(player.x + player.width / 2, player.y + player.height / 2, '#fff', 30);
      switchState(STATES.GAME_OVER);
    }
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt * 2;
    if (p.life <= 0) {
      particles[i] = particles[particles.length - 1];
      particles.pop();
    }
  }
}

// ============================================================
//  CHARACTER RENDERING (unchanged)
// ============================================================
function drawCharacter(img, hitboxX, hitboxY, hitboxW, hitboxH, targetHeight, flip) {
  const cached = getCachedScale(img, targetHeight);
  if (!cached) return;

  const drawW = cached.drawW;
  const drawH = cached.drawH;

  const centerX = hitboxX + hitboxW * 0.5;
  const bottomY = hitboxY + hitboxH;

  if (flip) {
    const dy = bottomY - drawH;
    ctx.save();
    ctx.translate(centerX, dy + drawH * 0.5);
    ctx.scale(-1, 1);
    ctx.drawImage(img, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(img, centerX - drawW * 0.5, bottomY - drawH, drawW, drawH);
  }
}

// ============================================================
//  DRAW — GAME WORLD
// ============================================================
function drawGameWorld() {
  if (bgCacheDirty) rebuildBgCache();
  if (bgCacheCanvas) {
    ctx.drawImage(bgCacheCanvas, 0, 0);
  } else {
    ctx.fillStyle = '#050510';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Enemies
  const canvasW = canvas.width;
  for (let i = 0, len = obstacles.length; i < len; i++) {
    const obs = obstacles[i];
    const targetH = CHARACTER_CONFIG[obs.type].targetHeight * spriteScaleFactor;
    if (obs.x + obs.width * 0.5 + targetH * 0.5 < 0 || obs.x + obs.width * 0.5 - targetH * 0.5 > canvasW) continue;

    const imgArray = obstacleSprites[obs.type];
    if (imgArray && imgArray.length > 0) {
      const frameIdx = obs.animFrame % imgArray.length;
      const img = imgArray[frameIdx];
      if (img && img.complete) {
        drawCharacter(img, obs.x, obs.y, obs.width, obs.height, targetH, true);
      }
    }
  }

  // Player
  const scaledHeroH = CHARACTER_CONFIG.hero.targetHeight * spriteScaleFactor;
  const imgArray = sprites[player.animState];
  if (imgArray && imgArray.length > 0) {
    const frameIdx = player.animFrame % imgArray.length;
    const img = imgArray[frameIdx];
    if (img && img.complete) {
      drawCharacter(img, player.x, player.y, player.width, player.height, scaledHeroH, false);
    }
  }

  // Particles
  for (let i = 0, len = particles.length; i < len; i++) {
    const p = particles[i];
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 4, 4);
  }
  ctx.globalAlpha = 1;
}

// ============================================================
//  DRAW — UI SCREENS
// ============================================================
function drawUI() {
  switch (currentState) {
    case STATES.HOME:
      drawHomeScreen();
      break;
    case STATES.PLAYING:
      drawHUD();
      break;
    case STATES.PAUSED:
      drawOverlay(THEME.overlayDark);
      drawPauseScreen();
      break;
    case STATES.GAME_OVER:
      drawOverlay(THEME.overlayDarker);
      drawGameOverScreen();
      break;
    case STATES.LEADERBOARD:
      if (previousState !== STATES.HOME) drawOverlay(THEME.overlayDark);
      drawLeaderboardScreen();
      break;
    case STATES.SETTINGS:
      if (previousState !== STATES.HOME) drawOverlay(THEME.overlayDark);
      drawSettingsScreen();
      break;
  }
}

function drawOverlay(color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// --- HOME SCREEN ---
function drawHomeScreen() {
  // Background with dark overlay
  drawOverlay(THEME.overlay);

  const cw = canvas.width;
  const ch = canvas.height;

  // FHC Logo
  if (fhcLogo.complete && fhcLogo.naturalWidth > 0) {
    const logoW = 70; // Reasonable small size
    const logoRatio = fhcLogo.naturalHeight / fhcLogo.naturalWidth;
    ctx.drawImage(fhcLogo, 20 + safeArea.left, 20 + safeArea.top, logoW, logoW * logoRatio);
  }

  // GENESIS event badge
  ctx.save();
  ctx.fillStyle = THEME.neonGreen;
  ctx.font = `600 11px ${FONT.body}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '3px';
  ctx.shadowColor = THEME.neonGreen;
  [15, 8, 3].forEach(blur => {
    ctx.shadowBlur = blur;
    ctx.fillText('· GENESIS ·', cw / 2, homeLayout.badgeY);
  });
  ctx.restore();

  // Title
  ctx.save();
  ctx.fillStyle = THEME.neonGreen;
  ctx.font = `48px ${FONT.title}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = THEME.neonGreen;
  [20, 10, 4].forEach(blur => {
    ctx.shadowBlur = blur;
    ctx.fillText('Bone Runner', cw / 2, homeLayout.titleY);
  });
  // Draw one final bright core pass in white to make it pop
  ctx.shadowBlur = 0;
  ctx.fillStyle = THEME.boneWhite;
  ctx.fillText('Bone Runner', cw / 2, homeLayout.titleY);
  ctx.restore();

  // Subtitle
  ctx.save();
  ctx.font = `16px ${FONT.body}`;
  ctx.fillStyle = THEME.boneWhiteMuted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 4;
  ctx.fillText('Survive as long as you can.', cw / 2, homeLayout.subtitleY);
  ctx.restore();

  // Welcome message
  const playerName = localStorage.getItem('bonerunner_player_name');
  if (playerName) {
    ctx.save();
    ctx.fillStyle = THEME.boneWhiteMuted;
    ctx.font = `14px ${FONT.body}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 2;
    ctx.fillText(`Welcome back, ${playerName}`, cw / 2, homeLayout.welcomeY);
    ctx.restore();
  }

  // Buttons
  for (const btn of activeButtons) btn.draw(ctx);

  // Countdown Timer
  const countdown = getCountdownText();
  ctx.save();
  ctx.fillStyle = isDeadlinePassed() ? THEME.mutedRed : THEME.boneWhiteMuted;
  ctx.font = `600 18px ${FONT.body}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 2;
  ctx.fillText(countdown, cw / 2, homeLayout.countdownY);
  ctx.restore();
}

// --- HUD ---
function drawHUD() {
  ctx.save();

  // Score pill — top left
  const scoreText = `${Math.floor(score)}`;
  ctx.font = `700 18px ${FONT.body}`;
  const metrics = ctx.measureText(scoreText);
  const pillW = metrics.width + 28;
  const pillH = 34;
  const pillX = 14 + safeArea.left;
  const pillY = 12 + safeArea.top;

  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 8, 'rgba(13, 13, 13, 0.65)');
  ctx.fillStyle = THEME.boneWhite;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 3;
  ctx.fillText(scoreText, pillX + 14, pillY + pillH / 2);

  ctx.restore();

  // Pause button
  for (const btn of activeButtons) btn.draw(ctx);
}

// --- PAUSE SCREEN ---
function drawPauseScreen() {
  if (!activePanel) return;

  activePanel.draw(ctx, () => {
    const px = activePanel.x;
    const py = activePanel.y;
    const pw = activePanel.width;

    ctx.fillStyle = THEME.boneWhite;
    ctx.font = `36px ${FONT.title}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fillText('Game Paused', px + pw / 2, py + 40);
  });

  for (const btn of activeButtons) btn.draw(ctx);
}

// --- GAME OVER SCREEN ---
function drawGameOverScreen() {
  if (!activePanel) return;

  activePanel.draw(ctx, () => {
    const px = activePanel.x;
    const py = activePanel.y;
    const pw = activePanel.width;

    // Title
    ctx.fillStyle = THEME.boneWhite;
    ctx.font = `38px ${FONT.title}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.fillText('💀 YOU DIED', px + pw / 2, py + 45);

    // Divider
    drawDivider(ctx, px + 30, py + 75, pw - 60);

    // Scores
    ctx.font = `700 20px ${FONT.body}`;
    ctx.fillStyle = THEME.boneWhite;
    ctx.shadowBlur = 3;
    ctx.fillText(`Score: ${Math.floor(score)}`, px + pw / 2, py + 105);
  });

  for (const btn of activeButtons) btn.draw(ctx);
}

// --- LEADERBOARD SCREEN ---
function drawLeaderboardScreen() {
  // If coming from HOME, draw background + overlay first
  if (previousState === STATES.HOME) {
    drawOverlay(THEME.overlay);
  }

  if (!activePanel) return;

  activePanel.draw(ctx, () => {
    const px = activePanel.x;
    const py = activePanel.y;
    const pw = activePanel.width;

    // Title
    ctx.fillStyle = THEME.boneWhite;
    ctx.font = `32px ${FONT.title}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fillText('Leaderboard', px + pw / 2, py + 40);

    // Divider
    drawDivider(ctx, px + 30, py + 68, pw - 60);

    if (leaderboardLoading) {
      ctx.font = `16px ${FONT.body}`;
      ctx.fillStyle = THEME.boneWhiteMuted;
      ctx.fillText('Loading...', px + pw / 2, py + 120);
    } else if (leaderboardData && leaderboardData.length > 0) {
      const rowH = 26;
      const rowAreaTop = py + 95;
      const rankRowH = 44;
      const rankGap = 14;
      const backButtonZoneHeight = 78; // btnH (48) + top/bottom padding (30)
      const rowAreaHeight = activePanel.height - 95 - rankRowH - rankGap * 2 - backButtonZoneHeight;
      const topPadding = (rowH / 2) + 4;
      
      leaderboardMaxScroll = Math.max(0, (leaderboardData.length * rowH) + topPadding - rowAreaHeight);

      ctx.save();
      ctx.beginPath();
      ctx.rect(px, rowAreaTop, pw, rowAreaHeight);
      ctx.clip();

      const startY = rowAreaTop + topPadding - leaderboardScrollY;
      const currentPlayerId = localStorage.getItem('bonerunner_player_id');
      const currentPlayerName = localStorage.getItem('bonerunner_player_name');

      ctx.textAlign = 'left';

      leaderboardData.forEach((p, idx) => {
        const y = startY + (idx * rowH);

        // Highlight current player
        if ((p.id && p.id === currentPlayerId) || (p.name && p.name === currentPlayerName)) {
          drawRoundedRect(ctx, px + 10, y - rowH / 2 - 4, pw - 20, rowH, 6, 'rgba(143, 209, 79, 0.13)');
        }

        // Highlight top 3
        if (idx === 0) ctx.fillStyle = '#FFD700'; // Gold
        else if (idx === 1) ctx.fillStyle = '#C0C0C0'; // Silver
        else if (idx === 2) ctx.fillStyle = '#CD7F32'; // Bronze
        else ctx.fillStyle = THEME.boneWhite;

        ctx.font = `600 14px ${FONT.body}`;
        ctx.fillText(`#${idx + 1}  ${p.name}`, px + 35, y);

        ctx.textAlign = 'right';
        ctx.fillText(p.high_score.toString(), px + pw - 35, y);
        ctx.textAlign = 'left';
      });
      ctx.restore();

      // --- Pinned "Your Rank" row ---
      if (playerRankData) {
        const rankBandY = py + activePanel.height - backButtonZoneHeight - rankGap - rankRowH;
        // Divider line 12px above the band (full inset matching title divider)
        drawDivider(ctx, px + 30, rankBandY - 12, pw - 60);
        // Background band (rounded)
        drawRoundedRect(ctx, px + 1, rankBandY, pw - 2, rankRowH, 6, 'rgba(143,209,79,0.1)');
        // Rank text
        ctx.fillStyle = THEME.pumpkinOrange;
        ctx.font = `600 13px ${FONT.body}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = THEME.textShadow;
        ctx.shadowBlur = 3;
        ctx.fillText(`Your Rank: #${playerRankData.rank}`, px + 20, rankBandY + rankRowH / 2);
        ctx.textAlign = 'right';
        ctx.fillText(`${playerRankData.high_score} pts`, px + pw - 20, rankBandY + rankRowH / 2);
      }
    } else {
      ctx.font = `16px ${FONT.body}`;
      ctx.fillStyle = THEME.boneWhiteMuted;
      ctx.fillText('No players found yet.', px + pw / 2, py + 120);
    }
  });

  for (const btn of activeButtons) btn.draw(ctx);
}

// --- SETTINGS SCREEN ---
function drawSettingsScreen() {
  // If coming from HOME, draw background + overlay first
  if (previousState === STATES.HOME) {
    drawOverlay(THEME.overlay);
  }

  if (!activePanel) return;

  activePanel.draw(ctx, () => {
    const px = activePanel.x;
    const py = activePanel.y;
    const pw = activePanel.width;

    // Title
    ctx.fillStyle = THEME.boneWhite;
    ctx.font = `32px ${FONT.title}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fillText('⚙ Settings', px + pw / 2, py + 38);
  });

  for (const btn of activeButtons) btn.draw(ctx);
}

// ============================================================
//  MAIN DRAW FRAME
// ============================================================
function drawRotateDeviceOverlay() {
  drawOverlay(THEME.deepPurpleSolid);
  const cw = canvas.width;
  const ch = canvas.height;

  ctx.save();
  ctx.fillStyle = THEME.boneWhite;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = `18px ${FONT.body}`;
  ctx.fillText('Please rotate your device', cw / 2, ch / 2 - 15);
  ctx.fillText('to continue playing.', cw / 2, ch / 2 + 15);
  ctx.restore();
}

function drawFrame() {
  if (currentState === STATES.LOADING) {
    ctx.fillStyle = THEME.charcoal;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    
    if (failedAssets.length > 0) {
      ctx.fillStyle = THEME.mutedRed;
      ctx.font = `600 24px ${FONT.body}`;
      ctx.textAlign = 'center';
      ctx.fillText('Failed to load some assets. Check console.', cx, cy - 20);
      
      ctx.fillStyle = THEME.boneWhiteMuted;
      ctx.font = `14px ${FONT.body}`;
      let startY = cy + 15;
      for (let i = 0; i < Math.min(3, failedAssets.length); i++) {
        ctx.fillText(failedAssets[i], cx, startY + i * 22);
      }
      if (failedAssets.length > 3) {
        ctx.fillText(`...and ${failedAssets.length - 3} more.`, cx, startY + 3 * 22 + 10);
      }
    } else {
      ctx.fillStyle = THEME.boneWhite;
      ctx.font = `32px ${FONT.title}`;
      ctx.textAlign = 'center';
      ctx.shadowColor = THEME.textShadow;
      ctx.shadowBlur = 4;
      ctx.fillText('Loading Assets...', cx, cy - 40);
      ctx.shadowBlur = 0; // reset
      
      const w = 300, h = 24, x = cx - w / 2, y = cy;
      
      ctx.strokeStyle = THEME.boneWhite;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      
      const progress = assetsTotal === 0 ? 1 : assetsLoaded / assetsTotal;
      ctx.fillStyle = THEME.pumpkinOrange;
      ctx.fillRect(x + 3, y + 3, (w - 6) * Math.max(0, Math.min(1, progress)), h - 6);
      
      ctx.fillStyle = THEME.boneWhite;
      ctx.font = `16px ${FONT.body}`;
      ctx.fillText(`${Math.floor(progress * 100)}%`, cx, y + h + 30);
      
      if (assetsLoaded >= assetsTotal && assetsTotal > 0) {
        if (!localStorage.getItem('bonerunner_player_id')) {
          switchState(STATES.REGISTER);
        } else {
          switchState(STATES.HOME);
        }
      }
    }
    return;
  }

  // Always draw background first
  if (bgCacheDirty) rebuildBgCache();
  if (bgCacheCanvas) {
    ctx.drawImage(bgCacheCanvas, 0, 0);
  } else {
    ctx.fillStyle = '#050510';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Draw game world if we're in a gameplay-related state
  if (currentState === STATES.PLAYING || currentState === STATES.PAUSED || currentState === STATES.GAME_OVER) {
    drawGameWorld();
  }

  // Draw UI on top
  drawUI();

  if (rotateOverlayVisible) {
    drawRotateDeviceOverlay();
  }
}

// ============================================================
//  GAME LOOP
// ============================================================
function gameLoop(timestamp) {
  if (currentState !== STATES.PLAYING && currentState !== STATES.GAME_OVER) return;

  const rawDt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;

  // Skip frames where the tab was backgrounded (large gaps)
  if (rawDt < 0.5) {
    // Clamp dt to ~30fps equivalent to prevent speed manipulation
    const dt = Math.min(rawDt, 0.034);
    update(dt);
    drawFrame();
  }

  animationFrameId = requestAnimationFrame(gameLoop);
}

// Also run a UI render loop for non-playing states that have animations
function uiRenderLoop() {
  if (currentState !== STATES.PLAYING) {
    drawFrame();
  }
  requestAnimationFrame(uiRenderLoop);
}

// ============================================================
//  INIT
// ============================================================
function init() {
  resize();
  setTimeout(resize, 100);

  // Initialize anonymous auth (binds browser to cryptographic identity)
  initAnonymousAuth();

  // Registration form setup
  const regForm = document.getElementById('registration-form');
  const regError = document.getElementById('reg-error');

  if (regForm) {
    regForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (regError) {
        regError.classList.add('hidden');
        regError.textContent = '';
      }

      const submitBtn = document.getElementById('reg-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Registering...';
      }

      try {
        const data = {
          name: document.getElementById('reg-name').value.trim(),
          phone: document.getElementById('reg-phone').value.trim(),
          department: document.getElementById('reg-department').value,
          semester: document.getElementById('reg-semester').value
        };

        const result = await registerPlayer(data);
        if (result && result.id) {
          localStorage.setItem('bonerunner_player_id', result.id);
          localStorage.setItem('bonerunner_player_name', data.name);
          regForm.reset();
          switchState(STATES.HOME);
        }
      } catch (err) {
        console.error(err);
        if (regError) {
          regError.textContent = 'Registration failed. Phone number may already be in use.';
          regError.classList.remove('hidden');
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Register';
        }
      }
    });
  }

  // Login form setup
  const loginToggle = document.getElementById('login-toggle');
  const registerToggle = document.getElementById('register-toggle');
  const loginFormWrapper = document.getElementById('login-form-wrapper');
  const loginSubmit = document.getElementById('login-submit');
  const loginError = document.getElementById('login-error');
  const infoClose = document.getElementById('info-close');

  if (infoClose) {
    infoClose.addEventListener('click', hideInfoOverlay);
  }

  function showLoginForm() {
    if (isDeadlinePassed()) return;
    regForm.classList.add('hidden');
    loginFormWrapper.classList.remove('hidden');
    loginToggle.classList.add('hidden');
    registerToggle.classList.remove('hidden');
    if (loginError) { loginError.classList.add('hidden'); loginError.textContent = ''; }
  }

  function showRegForm() {
    if (isDeadlinePassed()) return;
    loginFormWrapper.classList.add('hidden');
    regForm.classList.remove('hidden');
    registerToggle.classList.add('hidden');
    loginToggle.classList.remove('hidden');
    if (regError) { regError.classList.add('hidden'); regError.textContent = ''; }
  }

  if (isDeadlinePassed()) {
    if (regForm) regForm.classList.add('hidden');
    if (loginFormWrapper) loginFormWrapper.classList.add('hidden');
    const deadlineMsg = document.getElementById('deadline-message');
    if (deadlineMsg) deadlineMsg.classList.remove('hidden');
  }

  if (loginToggle) loginToggle.querySelector('span').addEventListener('click', showLoginForm);
  if (registerToggle) registerToggle.querySelector('span').addEventListener('click', showRegForm);

  if (loginSubmit) {
    loginSubmit.addEventListener('click', async () => {
      const phone = document.getElementById('login-phone').value.trim();
      if (!phone || phone.length !== 10) {
        if (loginError) { loginError.textContent = 'Please enter a valid 10-digit phone number.'; loginError.classList.remove('hidden'); }
        return;
      }
      loginSubmit.disabled = true;
      loginSubmit.textContent = 'Looking up...';
      if (loginError) loginError.classList.add('hidden');
      try {
        const player = await lookupPlayerByPhone(phone);
        if (player && player.id) {
          localStorage.setItem('bonerunner_player_id', player.id);
          localStorage.setItem('bonerunner_player_name', player.name);
          switchState(STATES.HOME);
        } else {
          if (loginError) { loginError.textContent = 'No registration found with this phone number.'; loginError.classList.remove('hidden'); }
        }
      } catch (err) {
        if (loginError) { loginError.textContent = 'Login failed. Please try again.'; loginError.classList.remove('hidden'); }
      } finally {
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'Log In';
      }
    });
  }

  // Unlock audio on first interaction
  const unlockAudio = () => {
    jumpSound.play().catch(() => { });
    jumpSound.pause();
    jumpSound.currentTime = 0;

    bgMusic.play().catch(() => { });
    bgMusic.pause();

    canvas.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  canvas.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  // ============================================================
  //  PWA & iOS STANDALONE SUPPORT
  // ============================================================
  let scrolled = false;
  const hideAddressBar = () => {
    if (!scrolled) {
      window.scrollTo(0, 1);
      scrolled = true;
    }
  };
  window.addEventListener('load', hideAddressBar);
  setTimeout(hideAddressBar, 500);

  const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
  const isStandalone = ('standalone' in window.navigator) && window.navigator.standalone;
  const isDismissed = localStorage.getItem('bonerunner_pwa_dismissed');

  if (isIos && !isStandalone && !isDismissed) {
    const banner = document.createElement('div');
    banner.innerHTML = `
      <div style="background-color: #151810; color: #E8ECE0; padding: 15px; text-align: center; font-family: 'Inter', sans-serif; position: fixed; bottom: 0; left: 0; width: 100%; z-index: 1000; border-top: 2px solid #8FD14F; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 10px; box-shadow: 0 -4px 10px rgba(0,0,0,0.5);">
        <p style="margin: 0; font-size: 14px; line-height: 1.4;">
          <strong>Add to Home Screen</strong> for the full fullscreen experience!<br>
          Tap the Share icon <span style="font-size: 18px; vertical-align: middle;">&#8681;</span> &rarr; Add to Home Screen.
        </p>
        <button id="pwa-dismiss" style="background-color: #8FD14F; color: #0D0D0D; border: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; cursor: pointer;">Got it</button>
      </div>
    `;
    document.body.appendChild(banner);
    document.getElementById('pwa-dismiss').addEventListener('click', () => {
      localStorage.setItem('bonerunner_pwa_dismissed', 'true');
      banner.remove();
    });
  }

  switchState(STATES.LOADING);
  requestAnimationFrame(uiRenderLoop);
}

init();

// ============================================================
//  DEVTOOLS DETECTION
// ============================================================
let devToolsWarningShown = false;
setInterval(() => {
  const threshold = 160;
  const isOpen = window.outerWidth - window.innerWidth > threshold || 
                 window.outerHeight - window.innerHeight > threshold;
                 
  const overlay = document.getElementById('devtools-overlay');
  
  if (isOpen) {
    if (currentState === STATES.PLAYING && !devToolsWarningShown) {
      devToolsWarningShown = true;
      if (overlay) overlay.style.display = 'flex';
      switchState(STATES.PAUSED);
    }
  } else {
    if (devToolsWarningShown) {
      devToolsWarningShown = false;
      if (overlay) overlay.style.display = 'none';
    }
  }
}, 1000);
