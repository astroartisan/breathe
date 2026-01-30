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

    // Soft tone frequencies (Hz) - calming musical notes
    const TONE_FREQUENCIES = {
        'Breathe in': 523.25,   // C5 - bright, uplifting
        'Hold': 392.00,         // G4 - stable, centered
        'Breathe out': 329.63   // E4 - warm, releasing
    };

    // Audio context and nodes
    let audioContext = null;
    let audioUnlocked = false;
    let currentTone = null;
    let silentBufferSource = null; // Keep alive buffer for iOS

    // Wake Lock for preventing screen sleep
    let wakeLock = null;
    let noSleepVideo = null; // Fallback for older iOS

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
    let soundEnabled = false;

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
            gain.gain.value = 0; // Silent
            silentBufferSource.connect(gain);
            gain.connect(audioContext.destination);
            silentBufferSource.start();
            console.log('Silent buffer started - iOS audio kept alive');
        } catch (e) {
            console.error('Silent buffer failed:', e);
        }
    }

    function stopSilentBuffer() {
        if (silentBufferSource) {
            try {
                silentBufferSource.stop();
                silentBufferSource.disconnect();
            } catch (e) {
                // Ignore
            }
            silentBufferSource = null;
        }
    }

    // Initialize audio context (must be called from user gesture)
    function initAudio() {
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log('AudioContext created, state:', audioContext.state);
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
            // Short, quiet beep to unlock
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.connect(gain);
            gain.connect(audioContext.destination);
            osc.frequency.value = 440;
            gain.gain.setValueAtTime(0.001, audioContext.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.01);
            osc.start(audioContext.currentTime);
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
        // Try Screen Wake Lock API first (iOS 16.4+)
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock acquired via API');

                wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock released');
                    wakeLock = null;
                    if (isRunning && document.visibilityState === 'visible') {
                        requestWakeLock();
                    }
                });
                return true;
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
                noSleepVideo.muted = true;
                const playPromise = noSleepVideo.play();

                if (playPromise !== undefined) {
                    await playPromise;
                    console.log('Wake Lock acquired via video fallback');
                    return true;
                }
            } catch (e) {
                console.log('Video wake lock failed:', e.message);
                try {
                    noSleepVideo.muted = true;
                    await noSleepVideo.play();
                    return true;
                } catch (e2) {
                    console.log('Second attempt failed:', e2.message);
                }
            }
        }

        return false;
    }

    function releaseWakeLock() {
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
            noSleepVideo.muted = true;
            noSleepVideo.loop = true;
            noSleepVideo.autoplay = false;

            // Properly formatted minimal WebM video (1x1 pixel, valid base64)
            const webmBase64 = 'GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCChARWKuBslLh3DkljofL4YJAIAAAIAyAAAAA0q2fOzq2gQAAAAAADuH2Uzf4iBAAAABABjAAAAAAAABZAAjQOA0YBAABAAABgAAAQIDQAE6ADrHHj8MAA==';

            noSleepVideo.src = 'data:video/webm;base64,' + webmBase64;
            noSleepVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
            document.body.appendChild(noSleepVideo);
            console.log('NoSleep video element created');
        } catch (e) {
            console.error('Failed to create NoSleep video:', e);
            noSleepVideo = null;
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            if (isRunning) {
                requestWakeLock();
                if (audioContext) {
                    if (audioContext.state === 'suspended') {
                        audioContext.resume().then(() => {
                            if (soundEnabled && isRunning) startSilentBuffer();
                        });
                    } else if (soundEnabled && isRunning) {
                        startSilentBuffer();
                    }
                }
            }
        } else {
            stopSilentBuffer();
        }
    });
    // ========== END WAKE LOCK ==========

    function stopCurrentTone() {
        if (currentTone) {
            try {
                const { oscillator, gainNode } = currentTone;
                const now = audioContext ? audioContext.currentTime : 0;
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(gainNode.gain.value || 0.0001, now);
                gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
                oscillator.stop(now + 0.1);
            } catch (e) {
                // Ignore
            }
            currentTone = null;
        }
    }

    function playSustainedTone(frequency, durationMs) {
        if (!soundEnabled) return;
        if (!audioContext) return;

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                actuallyPlaySustainedTone(frequency, durationMs);
            }).catch(() => {
                console.log('Could not resume audio context');
            });
        } else if (audioContext.state === 'running') {
            actuallyPlaySustainedTone(frequency, durationMs);
        }
    }

    function actuallyPlaySustainedTone(frequency, durationMs) {
        stopCurrentTone();

        try {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);

            const now = audioContext.currentTime;
            const durationSec = durationMs / 1000;
            const fadeInTime = Math.min(0.5, durationSec * 0.1);
            const fadeOutTime = Math.min(1.0, durationSec * 0.2);
            const maxVolume = 0.3;

            gainNode.gain.setValueAtTime(0.0001, now);
            gainNode.gain.exponentialRampToValueAtTime(maxVolume, now + fadeInTime);
            gainNode.gain.setValueAtTime(maxVolume, now + durationSec - fadeOutTime);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

            oscillator.start(now);
            oscillator.stop(now + durationSec + 0.05);

            currentTone = { oscillator, gainNode };

            oscillator.onended = () => {
                if (currentTone && currentTone.oscillator === oscillator) {
                    currentTone = null;
                }
            };

            console.log('Tone:', frequency, 'Hz for', durationSec, 's');
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
            console.log('Short tone:', frequency, 'Hz');
        } catch (e) {
            console.error('Error playing short tone:', e);
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
        startBtn.addEventListener('click', () => {
            initAudio();
            toggleSession();
        });

        startBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            initAudio();
            toggleSession();
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
            e.preventDefault();
            e.stopPropagation();
            initAudio();

            soundEnabled = !soundEnabled;
            updateSoundButton();
            saveState();

            if (soundEnabled && audioContext) {
                audioContext.resume().then(() => {
                    if (isRunning) startSilentBuffer();
                    setTimeout(() => playShortTone(523.25), 50);
                });
            } else {
                stopCurrentTone();
                stopSilentBuffer();
            }
        }

        soundBtn.addEventListener('touchend', handleSoundToggle, { passive: false });

        soundBtn.addEventListener('click', (e) => {
            if (e.pointerType === 'touch') return;
            handleSoundToggle(e);
        });

        const breathingContainer = document.querySelector('.breathing-container');

        breathingContainer.addEventListener('click', (e) => {
            if (!e.target.closest('.controls')) {
                initAudio();
                toggleSession();
            }
        });

        breathingContainer.addEventListener('touchend', (e) => {
            if (!e.target.closest('.controls')) {
                e.preventDefault();
                initAudio();
                toggleSession();
            }
        }, { passive: false });

        const unlockAudioOnTouch = () => {
            initAudio();
            document.removeEventListener('touchstart', unlockAudioOnTouch);
            document.removeEventListener('touchend', unlockAudioOnTouch);
        };

        document.addEventListener('touchstart', unlockAudioOnTouch, { passive: true });
        document.addEventListener('touchend', unlockAudioOnTouch, { passive: true });

        document.addEventListener('mousedown', () => {
            initAudio();
        }, { once: true });
    }

    function updateSoundButton() {
        soundBtn.classList.toggle('active', soundEnabled);
    }

    function onPhaseChange(phaseName, phaseDurationMs) {
        if (phaseName === lastPhaseName) return;
        lastPhaseName = phaseName;

        const frequency = TONE_FREQUENCIES[phaseName];
        if (frequency && soundEnabled) {
            playSustainedTone(frequency, phaseDurationMs);
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

        // CRITICAL: Request wake lock immediately in user gesture
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

        stopCurrentTone();
        stopSilentBuffer();
        releaseWakeLock();

        if (sessionDuration > 0 && sessionStartTime) {
            const elapsed = (performance.now() - sessionStartTime) / 1000;
            pausedTimeRemaining = Math.max(0, sessionDuration - elapsed);
        }

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        instruction.textContent = 'Paused';
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

        stopCurrentTone();
        stopSilentBuffer();
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
        releaseWakeLock();

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
            lastPhaseName = null;
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