(function () {
    'use strict';

    // Exercise configurations
    const EXERCISES = {
        relaxing: {
            name: 'Relaxing',
            phases: [
                { name: 'Breathe in', duration: 4000, scale: 'grow' },
                { name: 'Breathe out', duration: 6000, scale: 'shrink' }
            ]
        },
        calm: {
            name: '4-7-8',
            phases: [
                { name: 'Breathe in', duration: 4000, scale: 'grow' },
                { name: 'Hold', duration: 7000, scale: 'hold' },
                { name: 'Breathe out', duration: 8000, scale: 'shrink' }
            ]
        }
    };

    // Scale factors for GPU-accelerated transform
    const SCALE_MIN = 1;
    const SCALE_MAX = 2.5;

    // Phase tone profiles (Hz) - inhale rises, hold is flat, exhale damps
    const TONE_PROFILES = {
        'Breathe in': {
            startHz: 329.63, // E4
            endHz: 523.25,   // C5
            gain: 0.38,
            sweep: 'up',
            damp: false
        },
        'Hold': {
            startHz: 392.00, // G4
            endHz: 392.00,
            gain: 0.32,
            sweep: 'flat',
            damp: false
        },
        'Breathe out': {
            startHz: 392.00, // G4
            endHz: 261.63,   // C4
            gain: 0.38,
            sweep: 'down',
            damp: true
        }
    };

    // Audio context and nodes
    let audioContext = null;
    let audioUnlocked = false;
    let currentTone = null;
    let silentBufferSource = null;
    let activePhaseName = null; // Track which phase sound is currently playing for

    // Wake Lock for preventing screen sleep
    let wakeLock = null;
    let noSleepVideo = null;
    let wakeLockInterval = null; // Keep-alive interval

    // State
    let currentExercise = 'relaxing';
    let sessionDuration = 180;
    let isRunning = false;
    let currentPhaseIndex = 0;
    let cycleCount = 0;
    let animationFrameId = null;
    let phaseStartTime = null;
    let sessionStartTime = null;
    let pausedTimeRemaining = null;
    let lastPhaseName = null;
    let soundEnabled = true;

    // iOS double-tap / click guard
    const TOUCH_IGNORE_DELAY_MS = 700;
    let lastTouchTime = 0;

    function markTouch() {
        lastTouchTime = Date.now();
    }

    function shouldIgnoreClick() {
        return Date.now() - lastTouchTime < TOUCH_IGNORE_DELAY_MS;
    }

    // DOM elements
    const circle = document.querySelector('.breathing-circle');
    const instruction = document.querySelector('.instruction');
    const phaseTimer = document.querySelector('.phase-timer');
    const startBtn = document.querySelector('.start-btn');
    const resetBtn = document.querySelector('.reset-btn');
    const playIcon = document.querySelector('.play-icon');
    const pauseIcon = document.querySelector('.pause-icon');
    const cycleCountEl = document.querySelector('.cycle-count');
    const timeRemainingEl = document.querySelector('.time-remaining');
    const exerciseBtns = document.querySelectorAll('.exercise-btn');
    const timerBtns = document.querySelectorAll('.timer-btn:not(.sound-btn)');
    const soundBtn = document.getElementById('sound-btn');

    // iOS specific: create silent buffer to keep audio context alive
    function createSilentBuffer() {
        if (!audioContext) return;
        const buffer = audioContext.createBuffer(1, audioContext.sampleRate, audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < buffer.length; i++) {
            data[i] = 0;
        }
        return buffer;
    }

    function startSilentBuffer() {
        if (!audioContext || silentBufferSource) return;
        try {
            const buffer = createSilentBuffer();
            silentBufferSource = audioContext.createBufferSource();
            silentBufferSource.buffer = buffer;
            silentBufferSource.loop = true;
            const gain = audioContext.createGain();
            gain.gain.value = 0;
            silentBufferSource.connect(gain);
            gain.connect(audioContext.destination);
            silentBufferSource.start();
            console.log('Silent buffer started');
        } catch (e) {
            console.error('Silent buffer failed:', e);
        }
    }

    function stopSilentBuffer() {
        if (silentBufferSource) {
            try {
                silentBufferSource.stop();
                silentBufferSource.disconnect();
            } catch (e) { }
            silentBufferSource = null;
        }
    }

    // Initialize audio context (must be called from user gesture)
    function initAudio() {
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.error('Failed to create AudioContext:', e);
                return false;
            }
        }

        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        if (!audioUnlocked) {
            unlockIOSAudio();
        }

        return true;
    }

    function unlockIOSAudio() {
        if (!audioContext) return;
        try {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.connect(gain);
            gain.connect(audioContext.destination);
            osc.frequency.value = 440;
            gain.gain.setValueAtTime(0.001, audioContext.currentTime);
            osc.start();
            osc.stop(audioContext.currentTime + 0.01);

            audioUnlocked = true;
            console.log('iOS audio unlocked');
            startSilentBuffer();
        } catch (e) {
            console.error('Unlock failed:', e);
        }
    }

    // ========== WAKE LOCK IMPLEMENTATION ==========
    async function requestWakeLock() {
        // Clear any existing interval first
        if (wakeLockInterval) {
            clearInterval(wakeLockInterval);
            wakeLockInterval = null;
        }

        // Try Screen Wake Lock API first (iOS 16.4+)
        if ('wakeLock' in navigator) {
            try {
                if (!wakeLock) {
                    wakeLock = await navigator.wakeLock.request('screen');
                    console.log('Wake Lock acquired via API');

                    wakeLock.addEventListener('release', () => {
                        console.log('Wake Lock released by system');
                        wakeLock = null;
                        // Re-acquire if still in session (running or paused)
                        if (sessionStartTime || isRunning) {
                            requestWakeLock();
                        }
                    });
                }
            } catch (e) {
                console.log('Wake Lock API failed:', e.message);
            }
        }

        // Fallback: NoSleep video for older iOS
        if (!noSleepVideo) {
            createNoSleepVideo();
        }

        if (noSleepVideo) {
            try {
                if (noSleepVideo.paused) {
                    noSleepVideo.muted = true;
                    await noSleepVideo.play();
                    console.log('Video wake lock playing');
                }
            } catch (e) {
                console.log('Video play failed:', e.message);
            }
        }

        // Set up keep-alive interval to ensure video stays playing
        // iOS sometimes pauses videos after a while
        wakeLockInterval = setInterval(() => {
            if (noSleepVideo && noSleepVideo.paused && (isRunning || sessionStartTime)) {
                console.log('Video was paused, resuming...');
                noSleepVideo.play().catch(() => { });
            }
            // Also re-check system wake lock
            if ('wakeLock' in navigator && !wakeLock && (isRunning || sessionStartTime)) {
                requestWakeLock();
            }
        }, 5000); // Check every 5 seconds
    }

    function releaseWakeLock() {
        // Clear keep-alive
        if (wakeLockInterval) {
            clearInterval(wakeLockInterval);
            wakeLockInterval = null;
        }

        if (wakeLock) {
            wakeLock.release();
            wakeLock = null;
            console.log('Wake Lock released');
        }
        if (noSleepVideo) {
            noSleepVideo.pause();
            console.log('Video wake lock released');
        }
    }

    function createNoSleepVideo() {
        try {
            noSleepVideo = document.createElement('video');
            noSleepVideo.setAttribute('playsinline', '');
            noSleepVideo.setAttribute('muted', '');
            noSleepVideo.setAttribute('loop', '');
            noSleepVideo.muted = true;
            noSleepVideo.loop = true;
            noSleepVideo.autoplay = false;

            // Valid minimal MP4 (2x2 pixel, 1 second, silent) for iOS compatibility
            const mp4Base64 = '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';

            noSleepVideo.src = 'data:video/mp4;base64,' + mp4Base64;
            noSleepVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
            document.body.appendChild(noSleepVideo);
            console.log('NoSleep video created');
        } catch (e) {
            console.error('Failed to create NoSleep video:', e);
            noSleepVideo = null;
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Re-acquire everything when app comes back to foreground
            if (isRunning || sessionStartTime) {
                requestWakeLock();
                if (audioContext && audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                        startSilentBuffer();
                    });
                }
            }
        }
    });
    // ========== END WAKE LOCK ==========

    function stopCurrentTone() {
        if (currentTone) {
            try {
                const { oscillator, gainNode } = currentTone;
                const now = audioContext ? audioContext.currentTime : 0;
                // Smooth fade out over 0.2 seconds to avoid click
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(gainNode.gain.value || 0.001, now);
                gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
                oscillator.stop(now + 0.25);
            } catch (e) { }
            currentTone = null;
            activePhaseName = null;
        }
    }

    // Play phase tone with frequency sweep + damping for the exact duration
    function playPhaseTone(profile, durationMs, phaseName) {
        if (!soundEnabled || !audioContext) return;

        // Don't restart if already playing this exact phase
        if (activePhaseName === phaseName && currentTone) return;

        // Stop any previous tone first
        stopCurrentTone();
        activePhaseName = phaseName;

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                actuallyPlayPhaseTone(profile, durationMs, phaseName);
            });
        } else {
            actuallyPlayPhaseTone(profile, durationMs, phaseName);
        }
    }

    function actuallyPlayPhaseTone(profile, durationMs, phaseName) {
        try {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(profile.startHz, audioContext.currentTime);

            const now = audioContext.currentTime;
            const durationSec = durationMs / 1000;

            // Envelope: quick attack, long sustain, gentle release
            const attackTime = Math.min(0.25, durationSec * 0.12);
            const releaseTime = Math.min(0.6, durationSec * 0.18);
            const sustainLevel = profile.gain;

            gainNode.gain.setValueAtTime(0.0001, now);
            gainNode.gain.exponentialRampToValueAtTime(sustainLevel, now + attackTime);

            if (profile.damp) {
                // Exhale: gradually damp the tone
                gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
            } else {
                // Hold or inhale: keep level, then release near the end
                gainNode.gain.setValueAtTime(sustainLevel, now + durationSec - releaseTime);
                gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
            }

            if (profile.endHz !== profile.startHz) {
                oscillator.frequency.exponentialRampToValueAtTime(
                    profile.endHz,
                    now + durationSec
                );
            }

            oscillator.start(now);
            oscillator.stop(now + durationSec + 0.1);

            currentTone = { oscillator, gainNode, phaseName };

            oscillator.onended = () => {
                if (currentTone && currentTone.phaseName === phaseName) {
                    currentTone = null;
                    activePhaseName = null;
                }
            };

            console.log('Playing', phaseName, 'tone:', profile.startHz, 'Hz ->', profile.endHz, 'Hz for', durationSec, 'seconds');
        } catch (e) {
            console.error('Tone error:', e);
        }
    }

    function playShortTone(frequency) {
        if (!soundEnabled || !audioContext) return;

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => actuallyPlayShortTone(frequency));
            return;
        }
        actuallyPlayShortTone(frequency);
    }

    function actuallyPlayShortTone(frequency) {
        try {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.connect(gain);
            gain.connect(audioContext.destination);

            osc.type = 'sine';
            osc.frequency.value = frequency;

            const now = audioContext.currentTime;
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.exponentialRampToValueAtTime(0.4, now + 0.1);
            gain.gain.setValueAtTime(0.4, now + 0.3);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

            osc.start(now);
            osc.stop(now + 0.7);
        } catch (e) {
            console.error('Short tone error:', e);
        }
    }

    function playCompletionChime() {
        if (!soundEnabled || !audioContext) return;
        stopCurrentTone();

        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, i) => {
            setTimeout(() => playShortTone(freq), i * 250);
        });
    }

    function init() {
        loadState();
        setupEventListeners();
        updateUI();
        updateSoundButton();
    }

    function loadState() {
        try {
            const savedExercise = localStorage.getItem('breathe-exercise');
            if (savedExercise && EXERCISES[savedExercise]) {
                currentExercise = savedExercise;
                updateExerciseButtons();
            }

            const savedDuration = localStorage.getItem('breathe-duration');
            if (savedDuration !== null) {
                sessionDuration = parseInt(savedDuration, 10);
                updateTimerButtons();
            }

            const savedSound = localStorage.getItem('breathe-sound');
            if (savedSound !== null) {
                soundEnabled = savedSound === 'true';
            }
        } catch (e) {
            // localStorage not available
        }
    }

    function saveState() {
        try {
            localStorage.setItem('breathe-exercise', currentExercise);
            localStorage.setItem('breathe-duration', sessionDuration.toString());
            localStorage.setItem('breathe-sound', soundEnabled.toString());
        } catch (e) {
            // localStorage not available
        }
    }

    function setupEventListeners() {
        // Start button handlers
        const handleStart = (e) => {
            if (e) e.preventDefault();
            initAudio();
            toggleSession();
        };

        startBtn.addEventListener('click', (e) => {
            if (shouldIgnoreClick()) return;
            handleStart(e);
        });
        startBtn.addEventListener('touchend', (e) => {
            markTouch();
            handleStart(e);
        }, { passive: false });

        resetBtn.addEventListener('click', resetSession);

        exerciseBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                if (isRunning) return;
                const exercise = btn.dataset.exercise;
                if (exercise && EXERCISES[exercise]) {
                    currentExercise = exercise;
                    updateExerciseButtons();
                    saveState();
                }
            });
        });

        timerBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                if (isRunning) return;
                const duration = parseInt(btn.dataset.duration, 10);
                sessionDuration = duration;
                updateTimerButtons();
                updateTimeRemainingDisplay();
                saveState();
            });
        });

        function handleSoundToggle(e) {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            initAudio();

            soundEnabled = !soundEnabled;
            updateSoundButton();
            saveState();

            if (soundEnabled && audioContext) {
                audioContext.resume().then(() => {
                    startSilentBuffer();
                    setTimeout(() => playShortTone(523.25), 50);
                });
            } else {
                stopCurrentTone();
                stopSilentBuffer();
            }
        }

        soundBtn.addEventListener('touchend', (e) => {
            markTouch();
            handleSoundToggle(e);
        }, { passive: false });
        soundBtn.addEventListener('click', (e) => {
            if (shouldIgnoreClick()) return;
            handleSoundToggle(e);
        });

        // Tap circle to start/pause
        const breathingContainer = document.querySelector('.breathing-container');
        const handleContainerTap = (e) => {
            if (!e.target.closest('.controls')) {
                if (e) e.preventDefault();
                initAudio();
                toggleSession();
            }
        };

        breathingContainer.addEventListener('click', (e) => {
            if (shouldIgnoreClick()) return;
            handleContainerTap(e);
        });
        breathingContainer.addEventListener('touchend', (e) => {
            markTouch();
            handleContainerTap(e);
        }, { passive: false });

        // Global unlock on first interaction
        const unlockOnce = () => {
            initAudio();
            document.removeEventListener('touchstart', unlockOnce);
            document.removeEventListener('touchend', unlockOnce);
            document.removeEventListener('click', unlockOnce);
        };
        document.addEventListener('touchstart', unlockOnce, { passive: true, once: true });
        document.addEventListener('touchend', unlockOnce, { passive: true, once: true });
        document.addEventListener('click', unlockOnce, { once: true });
    }

    function updateSoundButton() {
        soundBtn.classList.toggle('active', soundEnabled);
    }

    function onPhaseChange(phaseName, phaseDurationMs) {
        if (phaseName === lastPhaseName) return;
        lastPhaseName = phaseName;

        const profile = TONE_PROFILES[phaseName];
        if (profile && soundEnabled) {
            // Play tone for the full duration of this phase
            playPhaseTone(profile, phaseDurationMs, phaseName);
        }
    }

    function updateExerciseButtons() {
        exerciseBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.exercise === currentExercise);
        });
    }

    function updateTimerButtons() {
        timerBtns.forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.duration, 10) === sessionDuration);
        });
    }

    function toggleSession() {
        if (isRunning) {
            pauseSession();
        } else {
            startSession();
        }
    }

    function startSession() {
        isRunning = true;
        resetBtn.disabled = false;
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
        lastPhaseName = null;

        exerciseBtns.forEach(btn => btn.style.pointerEvents = 'none');
        timerBtns.forEach(btn => btn.style.pointerEvents = 'none');

        // Keep screen on (works for running and paused states)
        requestWakeLock();

        if (soundEnabled) startSilentBuffer();

        const now = performance.now();
        phaseStartTime = now;

        if (pausedTimeRemaining !== null && sessionDuration > 0) {
            sessionStartTime = now - ((sessionDuration - pausedTimeRemaining) * 1000);
            pausedTimeRemaining = null;
        } else if (!sessionStartTime) {
            sessionStartTime = now;
        }

        runAnimation();
    }

    function pauseSession() {
        isRunning = false;
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');

        // Stop sound but KEEP screen wake lock active!
        stopCurrentTone();
        // Don't stop silent buffer - keep audio context warm

        // NOTE: We do NOT release wake lock here, so screen stays on while paused
        // This allows user to resume without unlocking phone

        if (sessionDuration > 0 && sessionStartTime) {
            const elapsed = (performance.now() - sessionStartTime) / 1000;
            pausedTimeRemaining = Math.max(0, sessionDuration - elapsed);
        }

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        instruction.textContent = 'Paused - Tap to resume';
        phaseTimer.textContent = '';
    }

    function resetSession() {
        isRunning = false;
        currentPhaseIndex = 0;
        cycleCount = 0;
        phaseStartTime = null;
        sessionStartTime = null;
        pausedTimeRemaining = null;
        lastPhaseName = null;
        activePhaseName = null;

        stopCurrentTone();
        stopSilentBuffer();

        // Only release wake lock when fully reset
        releaseWakeLock();

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
        resetBtn.disabled = true;

        exerciseBtns.forEach(btn => btn.style.pointerEvents = '');
        timerBtns.forEach(btn => btn.style.pointerEvents = '');

        circle.style.transform = `scale(${SCALE_MIN})`;

        updateUI();
    }

    function completeSession() {
        isRunning = false;

        stopCurrentTone();
        stopSilentBuffer();
        // Keep wake lock for a moment so user sees "Complete", then release
        setTimeout(releaseWakeLock, 2000);

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');

        instruction.textContent = 'Complete';
        phaseTimer.textContent = '';
        timeRemainingEl.textContent = '0:00';

        setTimeout(playCompletionChime, 150);
    }

    function runAnimation() {
        if (!isRunning) return;

        const exercise = EXERCISES[currentExercise];
        const phase = exercise.phases[currentPhaseIndex];
        const now = performance.now();
        const elapsed = now - phaseStartTime;
        const progress = Math.min(elapsed / phase.duration, 1);

        updateCircleScale(phase, progress);

        instruction.textContent = phase.name;
        const remaining = Math.ceil((phase.duration - elapsed) / 1000);
        phaseTimer.textContent = remaining > 0 ? `${remaining}s` : '';

        // Trigger phase sound - only once per phase change
        onPhaseChange(phase.name, phase.duration);

        updateTimeRemaining(now);

        if (sessionDuration > 0) {
            const sessionElapsed = (now - sessionStartTime) / 1000;
            if (sessionElapsed >= sessionDuration) {
                completeSession();
                return;
            }
        }

        if (progress >= 1) {
            currentPhaseIndex++;

            if (currentPhaseIndex >= exercise.phases.length) {
                currentPhaseIndex = 0;
                cycleCount++;
                updateCycleCount();
            }

            phaseStartTime = now;
            lastPhaseName = null; // Reset to trigger next phase sound
        }

        animationFrameId = requestAnimationFrame(runAnimation);
    }

    function updateCircleScale(phase, progress) {
        const easedProgress = easeInOutSine(progress);
        let scale;

        if (phase.scale === 'grow') {
            scale = SCALE_MIN + (SCALE_MAX - SCALE_MIN) * easedProgress;
        } else if (phase.scale === 'shrink') {
            scale = SCALE_MAX - (SCALE_MAX - SCALE_MIN) * easedProgress;
        } else {
            scale = SCALE_MAX;
        }

        circle.style.transform = `scale(${scale})`;
    }

    function easeInOutSine(x) {
        return -(Math.cos(Math.PI * x) - 1) / 2;
    }

    function updateTimeRemaining(now) {
        if (sessionDuration === 0) {
            timeRemainingEl.textContent = '';
            return;
        }

        const sessionElapsed = (now - sessionStartTime) / 1000;
        const remaining = Math.max(0, sessionDuration - sessionElapsed);
        const mins = Math.floor(remaining / 60);
        const secs = Math.ceil(remaining % 60);

        timeRemainingEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function updateUI() {
        instruction.textContent = 'Tap to begin';
        phaseTimer.textContent = '';
        circle.style.transform = `scale(${SCALE_MIN})`;
        updateCycleCount();
        updateTimeRemainingDisplay();
    }

    function updateTimeRemainingDisplay() {
        if (sessionDuration === 0) {
            timeRemainingEl.textContent = '∞';
        } else {
            const mins = Math.floor(sessionDuration / 60);
            const secs = sessionDuration % 60;
            timeRemainingEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    }

    function updateCycleCount() {
        cycleCountEl.textContent = cycleCount === 1 ? '1 cycle' : `${cycleCount} cycles`;
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then(reg => console.log('SW registered'))
                .catch(err => console.log('SW registration failed:', err));
        });
    }

    init();
})();
