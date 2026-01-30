(function() {
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

    // Audio context (created on first user interaction)
    let audioContext = null;
    let audioUnlocked = false;
    let currentTone = null; // Track the currently playing sustained tone
    let silentOscillator = null; // Keep audio context alive on iOS

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

    // Initialize audio context (must be called from user gesture)
    // iOS is VERY strict - must create, resume, AND play in same synchronous gesture
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

        // iOS unlock sequence - must happen synchronously in user gesture
        if (!audioUnlocked && audioContext) {
            // First, try to resume (required for iOS)
            const resumePromise = audioContext.resume();

            // Play unlock tone immediately (don't wait for promise)
            // iOS needs this in the same call stack as the gesture
            try {
                // Create a short, audible tone to force iOS to unlock
                const osc = audioContext.createOscillator();
                const gain = audioContext.createGain();
                osc.connect(gain);
                gain.connect(audioContext.destination);

                // Use audible frequency - iOS ignores inaudible ones
                osc.type = 'sine';
                osc.frequency.value = 440;

                // Very brief, quiet beep
                const now = audioContext.currentTime;
                gain.gain.setValueAtTime(0.001, now);
                gain.gain.linearRampToValueAtTime(0.05, now + 0.01);
                gain.gain.linearRampToValueAtTime(0.001, now + 0.05);

                osc.start(now);
                osc.stop(now + 0.1);

                console.log('iOS unlock tone played, context state:', audioContext.state);
            } catch (e) {
                console.error('iOS unlock tone failed:', e);
            }

            // Also handle the resume promise
            resumePromise.then(() => {
                audioUnlocked = true;
                console.log('AudioContext resumed, state:', audioContext.state);
            }).catch(e => {
                console.error('Resume failed:', e);
            });

            // Mark as unlocked optimistically (the tone was played in user gesture)
            audioUnlocked = true;
        } else if (audioContext.state === 'suspended') {
            // Already unlocked but suspended (e.g., tab was backgrounded)
            audioContext.resume();
        }

        return true;
    }

    // Start a silent oscillator to keep audio context alive on iOS
    // This prevents iOS from suspending the context between tones
    function startSilentOscillator() {
        if (!audioContext || silentOscillator) return;

        try {
            silentOscillator = audioContext.createOscillator();
            const silentGain = audioContext.createGain();
            silentGain.gain.value = 0; // Completely silent
            silentOscillator.connect(silentGain);
            silentGain.connect(audioContext.destination);
            silentOscillator.start();
            console.log('Silent oscillator started to keep audio context alive');
        } catch (e) {
            console.error('Failed to start silent oscillator:', e);
        }
    }

    // Stop the silent oscillator
    function stopSilentOscillator() {
        if (silentOscillator) {
            try {
                silentOscillator.stop();
            } catch (e) {
                // Ignore - might already be stopped
            }
            silentOscillator = null;
        }
    }

    // ========== WAKE LOCK IMPLEMENTATION ==========
    // Prevents screen from auto-locking during breathing sessions

    // Request wake lock using modern API
    async function requestWakeLock() {
        // Try Screen Wake Lock API first (iOS 16.4+, modern browsers)
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock acquired via API');

                // Re-acquire if released (e.g., tab switch)
                wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock released');
                    wakeLock = null;
                    // Re-acquire if still running
                    if (isRunning) {
                        requestWakeLock();
                    }
                });
                return true;
            } catch (e) {
                console.log('Wake Lock API failed:', e.message);
            }
        }

        // Fallback: NoSleep video trick for older iOS
        // Playing a tiny video keeps the screen awake
        if (!noSleepVideo) {
            createNoSleepVideo();
        }
        if (noSleepVideo) {
            try {
                // The video must be triggered from a user gesture
                await noSleepVideo.play();
                console.log('Wake Lock acquired via video fallback');
                return true;
            } catch (e) {
                console.log('Video wake lock failed:', e.message);
            }
        }

        return false;
    }

    // Release wake lock
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

    // Create a tiny looping video for the NoSleep fallback
    // This uses a data URI of a minimal webm video
    function createNoSleepVideo() {
        try {
            noSleepVideo = document.createElement('video');
            noSleepVideo.setAttribute('playsinline', '');
            noSleepVideo.setAttribute('muted', '');
            noSleepVideo.muted = true;
            noSleepVideo.loop = true;

            // Minimal webm video (base64 encoded)
            // This is a tiny 1x1 pixel, 1 frame webm that loops
            const webmBase64 = 'GkXfowEAAAAAAAAfQoaBAUL3gQFC8oEEQvOBCEKChHdlYm1Ch4EEQoWBAhhTgGcBAAAAAAAVkhFNm3RALE27i1OrhBVJqWZTrIHfTbuMU6uEFlSua1OsggEwTbuMU6uEHFO7a1OsggHL';

            noSleepVideo.src = 'data:video/webm;base64,' + webmBase64;
            noSleepVideo.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;';
            document.body.appendChild(noSleepVideo);
            console.log('NoSleep video element created');
        } catch (e) {
            console.error('Failed to create NoSleep video:', e);
            noSleepVideo = null;
        }
    }

    // Re-acquire wake lock when page becomes visible again
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isRunning) {
            requestWakeLock();
            // Also resume audio context if needed
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
        }
    });

    // ========== END WAKE LOCK ==========

    // Stop any currently playing tone
    function stopCurrentTone() {
        if (currentTone) {
            try {
                const { oscillator, gainNode } = currentTone;
                const now = audioContext.currentTime;
                // Quick fade out to avoid click
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(gainNode.gain.value, now);
                gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                oscillator.stop(now + 0.15);
            } catch (e) {
                // Ignore - oscillator might already be stopped
            }
            currentTone = null;
        }
    }

    // Play a sustained tone for a breathing phase
    // durationMs: how long the phase lasts
    // NOTE: This is called from the animation loop, not a user gesture,
    // so we rely on the silent oscillator keeping the context alive
    function playSustainedTone(frequency, durationMs) {
        if (!soundEnabled) {
            return;
        }
        if (!audioContext) {
            console.log('No audio context');
            return;
        }

        // If context is suspended, try to resume (won't work without user gesture but worth trying)
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }

        // Don't wait for promise - play immediately if context is running
        // The silent oscillator should keep the context alive
        if (audioContext.state === 'running') {
            actuallyPlaySustainedTone(frequency, durationMs);
        } else {
            console.log('Audio context not running, state:', audioContext.state);
        }
    }

    function actuallyPlaySustainedTone(frequency, durationMs) {
        // Stop any existing tone first
        stopCurrentTone();

        try {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Soft sine wave for meditative feel
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);

            const now = audioContext.currentTime;
            const durationSec = durationMs / 1000;
            const fadeInTime = Math.min(0.8, durationSec * 0.15);  // 15% of duration, max 0.8s
            const fadeOutTime = Math.min(1.2, durationSec * 0.25); // 25% of duration, max 1.2s
            const maxVolume = 0.35; // Comfortable sustained volume

            // Envelope: fade in -> sustain -> fade out
            gainNode.gain.setValueAtTime(0.001, now);
            gainNode.gain.exponentialRampToValueAtTime(maxVolume, now + fadeInTime);
            // Hold at max volume until fade out begins
            gainNode.gain.setValueAtTime(maxVolume, now + durationSec - fadeOutTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

            oscillator.start(now);
            oscillator.stop(now + durationSec + 0.1);

            // Track current tone for potential early stop
            currentTone = { oscillator, gainNode };

            oscillator.onended = () => {
                if (currentTone && currentTone.oscillator === oscillator) {
                    currentTone = null;
                }
            };

            console.log('Sustained tone:', frequency, 'Hz for', durationSec.toFixed(1), 's');
        } catch (e) {
            console.error('Error playing sustained tone:', e);
        }
    }

    // Play a short tone (for test/feedback)
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

    // Play completion chime (gentle arpeggio)
    function playCompletionChime() {
        if (!soundEnabled || !audioContext) return;
        stopCurrentTone();

        const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 - major chord
        notes.forEach((freq, i) => {
            setTimeout(() => playShortTone(freq), i * 250);
        });
    }

    // Initialize
    function init() {
        loadState();
        setupEventListeners();
        updateUI();
        updateSoundButton();
    }

    // Load saved state from localStorage
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

    // Save state to localStorage
    function saveState() {
        try {
            localStorage.setItem('breathe-exercise', currentExercise);
            localStorage.setItem('breathe-duration', sessionDuration.toString());
            localStorage.setItem('breathe-sound', soundEnabled.toString());
        } catch (e) {
            // localStorage not available
        }
    }

    // Setup event listeners
    function setupEventListeners() {
        // Start button - click for desktop
        startBtn.addEventListener('click', () => {
            initAudio();
            toggleSession();
        });

        // Start button - touchend for iOS (more reliable for audio)
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

        // Sound button handler - shared logic
        function handleSoundToggle(e) {
            e.preventDefault();
            e.stopPropagation();

            // MUST init audio in the touch/click handler for iOS
            initAudio();

            soundEnabled = !soundEnabled;
            updateSoundButton();
            saveState();

            // Play test tone when enabling
            if (soundEnabled && audioContext) {
                // Force resume and play
                audioContext.resume().then(() => {
                    // Start silent oscillator if session is running
                    if (isRunning) {
                        startSilentOscillator();
                    }
                    // Small delay to ensure iOS is ready
                    setTimeout(() => {
                        playShortTone(523.25);
                    }, 50);
                });
            } else {
                // Sound disabled - stop any playing tone and silent oscillator
                stopCurrentTone();
                stopSilentOscillator();
            }
        }

        // iOS: touchend is more reliable than click for audio
        soundBtn.addEventListener('touchend', handleSoundToggle, { passive: false });

        // Desktop: use click
        soundBtn.addEventListener('click', (e) => {
            // Avoid double-firing on touch devices
            if (e.pointerType === 'touch') return;
            handleSoundToggle(e);
        });

        // Allow tapping the circle to start
        const breathingContainer = document.querySelector('.breathing-container');

        breathingContainer.addEventListener('click', (e) => {
            if (!e.target.closest('.controls')) {
                initAudio();
                toggleSession();
            }
        });

        // iOS: touchend on container to start (more reliable for audio)
        breathingContainer.addEventListener('touchend', (e) => {
            if (!e.target.closest('.controls')) {
                e.preventDefault();
                initAudio();
                toggleSession();
            }
        }, { passive: false });

        // iOS: Unlock audio on first touch anywhere
        // Must use touchend (not touchstart) for iOS audio unlock
        const unlockAudioOnTouch = (e) => {
            console.log('Touch detected, unlocking audio...');
            initAudio();
            // Remove after first successful unlock
            document.removeEventListener('touchstart', unlockAudioOnTouch);
            document.removeEventListener('touchend', unlockAudioOnTouch);
        };

        document.addEventListener('touchstart', unlockAudioOnTouch, { passive: true });
        document.addEventListener('touchend', unlockAudioOnTouch, { passive: true });

        // Mouse users
        document.addEventListener('mousedown', () => {
            initAudio();
        }, { once: true });
    }

    // Update sound button state
    function updateSoundButton() {
        soundBtn.classList.toggle('active', soundEnabled);
    }

    // Handle phase change - start sustained tone for the phase duration
    function onPhaseChange(phaseName, phaseDurationMs) {
        if (phaseName === lastPhaseName) return;
        lastPhaseName = phaseName;

        // Start sustained tone for this phase
        const frequency = TONE_FREQUENCIES[phaseName];
        if (frequency && soundEnabled) {
            console.log('Phase:', phaseName, '- sustained tone', frequency, 'Hz for', phaseDurationMs, 'ms');
            playSustainedTone(frequency, phaseDurationMs);
        }
    }

    // Update exercise button states
    function updateExerciseButtons() {
        exerciseBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.exercise === currentExercise);
        });
    }

    // Update timer button states
    function updateTimerButtons() {
        timerBtns.forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.duration, 10) === sessionDuration);
        });
    }

    // Toggle session start/pause
    function toggleSession() {
        if (isRunning) {
            pauseSession();
        } else {
            startSession();
        }
    }

    // Start breathing session
    function startSession() {
        isRunning = true;
        resetBtn.disabled = false;
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
        lastPhaseName = null;

        // Disable selection while running
        exerciseBtns.forEach(btn => btn.style.pointerEvents = 'none');
        timerBtns.forEach(btn => btn.style.pointerEvents = 'none');

        // Request wake lock to prevent screen sleep (called from user gesture)
        requestWakeLock();

        // Start silent oscillator to keep audio context alive on iOS
        if (soundEnabled && audioContext) {
            startSilentOscillator();
        }

        const now = performance.now();
        phaseStartTime = now;

        // Handle resume from pause
        if (pausedTimeRemaining !== null && sessionDuration > 0) {
            sessionStartTime = now - ((sessionDuration - pausedTimeRemaining) * 1000);
            pausedTimeRemaining = null;
        } else if (!sessionStartTime) {
            sessionStartTime = now;
        }

        runAnimation();
    }

    // Pause session
    function pauseSession() {
        isRunning = false;
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');

        // Stop any playing tone and silent oscillator
        stopCurrentTone();
        stopSilentOscillator();

        // Release wake lock when paused
        releaseWakeLock();

        // Save remaining time for resume
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

    // Reset session
    function resetSession() {
        isRunning = false;
        currentPhaseIndex = 0;
        cycleCount = 0;
        phaseStartTime = null;
        sessionStartTime = null;
        pausedTimeRemaining = null;
        lastPhaseName = null;

        // Stop any playing tone and silent oscillator
        stopCurrentTone();
        stopSilentOscillator();

        // Release wake lock
        releaseWakeLock();

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
        resetBtn.disabled = true;

        // Re-enable selection
        exerciseBtns.forEach(btn => btn.style.pointerEvents = '');
        timerBtns.forEach(btn => btn.style.pointerEvents = '');

        // Reset circle to minimum scale
        circle.style.transform = `scale(${SCALE_MIN})`;

        updateUI();
    }

    // Complete session
    function completeSession() {
        isRunning = false;

        // Stop any playing tone first
        stopCurrentTone();
        stopSilentOscillator();

        // Release wake lock
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

        // Completion feedback (short delay to let tone fade)
        setTimeout(playCompletionChime, 150);
    }

    // Main animation loop using requestAnimationFrame
    function runAnimation() {
        if (!isRunning) return;

        const exercise = EXERCISES[currentExercise];
        const phase = exercise.phases[currentPhaseIndex];
        const now = performance.now();
        const elapsed = now - phaseStartTime;
        const progress = Math.min(elapsed / phase.duration, 1);

        // Update circle scale using GPU-accelerated transform
        updateCircleScale(phase, progress);

        // Update instruction and timer
        instruction.textContent = phase.name;
        const remaining = Math.ceil((phase.duration - elapsed) / 1000);
        phaseTimer.textContent = remaining > 0 ? `${remaining}s` : '';

        // Trigger phase change feedback (with duration for sustained tone)
        onPhaseChange(phase.name, phase.duration);

        // Update session time remaining
        updateTimeRemaining(now);

        // Check if session time is up
        if (sessionDuration > 0) {
            const sessionElapsed = (now - sessionStartTime) / 1000;
            if (sessionElapsed >= sessionDuration) {
                completeSession();
                return;
            }
        }

        // Check if phase is complete
        if (progress >= 1) {
            currentPhaseIndex++;

            // Check if cycle is complete
            if (currentPhaseIndex >= exercise.phases.length) {
                currentPhaseIndex = 0;
                cycleCount++;
                updateCycleCount();
            }

            phaseStartTime = now;
            lastPhaseName = null; // Reset to trigger next phase feedback
        }

        animationFrameId = requestAnimationFrame(runAnimation);
    }

    // Update circle scale using GPU-accelerated transform
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

    // Smooth easing function
    function easeInOutSine(x) {
        return -(Math.cos(Math.PI * x) - 1) / 2;
    }

    // Update time remaining display during animation
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

    // Update UI to initial state
    function updateUI() {
        instruction.textContent = 'Tap to begin';
        phaseTimer.textContent = '';
        circle.style.transform = `scale(${SCALE_MIN})`;
        updateCycleCount();
        updateTimeRemainingDisplay();
    }

    // Update time remaining display for initial state
    function updateTimeRemainingDisplay() {
        if (sessionDuration === 0) {
            timeRemainingEl.textContent = '∞';
        } else {
            const mins = Math.floor(sessionDuration / 60);
            const secs = sessionDuration % 60;
            timeRemainingEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    }

    // Update cycle count display
    function updateCycleCount() {
        cycleCountEl.textContent = cycleCount === 1 ? '1 cycle' : `${cycleCount} cycles`;
    }

    // Register service worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then(reg => console.log('SW registered'))
                .catch(err => console.log('SW registration failed:', err));
        });
    }

    // Initialize app
    init();
})();
