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
    function initAudio() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // iOS requires both resume AND playing a sound in the same user gesture
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        // Unlock audio on iOS by playing a silent buffer
        if (!audioUnlocked && audioContext) {
            try {
                const buffer = audioContext.createBuffer(1, 1, 22050);
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start(0);
                audioUnlocked = true;
            } catch (e) {
                // Ignore errors
            }
        }
    }

    // Play a soft tone
    function playTone(frequency) {
        if (!soundEnabled || !audioContext) return;

        // Ensure audio context is running
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        try {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Soft sine wave
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);

            // Gentle envelope - soft attack, sustain, soft release
            const now = audioContext.currentTime;
            const attackTime = 0.1;
            const sustainTime = 0.3;
            const releaseTime = 0.4;
            const maxVolume = 0.2; // Slightly louder for iOS

            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(maxVolume, now + attackTime);
            gainNode.gain.setValueAtTime(maxVolume, now + attackTime + sustainTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + attackTime + sustainTime + releaseTime);

            oscillator.start(now);
            oscillator.stop(now + attackTime + sustainTime + releaseTime + 0.1);
        } catch (e) {
            // Audio not supported
        }
    }

    // Play completion chime (gentle arpeggio)
    function playCompletionChime() {
        if (!soundEnabled || !audioContext) return;

        const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 - major chord
        notes.forEach((freq, i) => {
            setTimeout(() => playTone(freq), i * 150);
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
        startBtn.addEventListener('click', () => {
            initAudio();
            toggleSession();
        });
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

        // Sound button
        soundBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent timer button behavior
            initAudio();
            soundEnabled = !soundEnabled;
            updateSoundButton();
            saveState();
            if (soundEnabled) {
                // Small delay to ensure iOS audio is fully unlocked
                setTimeout(() => {
                    playTone(440); // A4 test tone
                }, 50);
            }
        });

        // Allow tapping the circle to start
        document.querySelector('.breathing-container').addEventListener('click', (e) => {
            if (!e.target.closest('.controls')) {
                initAudio();
                toggleSession();
            }
        });
    }

    // Update sound button state
    function updateSoundButton() {
        soundBtn.classList.toggle('active', soundEnabled);
    }

    // Handle phase change - play tone
    function onPhaseChange(phaseName) {
        if (phaseName === lastPhaseName) return;
        lastPhaseName = phaseName;

        // Play tone
        const frequency = TONE_FREQUENCIES[phaseName];
        if (frequency) {
            playTone(frequency);
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

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');

        instruction.textContent = 'Complete';
        phaseTimer.textContent = '';
        timeRemainingEl.textContent = '0:00';

        // Completion feedback
        playCompletionChime();
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

        // Trigger phase change feedback
        onPhaseChange(phase.name);

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
