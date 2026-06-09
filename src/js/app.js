import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { sonioxClient } from './soniox.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { audioPlayer } from './audio-player.js';
import { sessionStore } from './session-store.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false;
        this.currentSource = 'system';
        this.translationMode = 'soniox';
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.recordingStartTime = null;
        
        // --- CUSTOM VARS: AI & Presentation Mode ---
        this.appMode = localStorage.getItem('my_app_mode') || 'discussion';
        this.presentationBufferTime = parseInt(localStorage.getItem('my_presentation_buffer')) || 5000;
        this.presentationBuffer = [];
        this.presentationTimer = null;
        window.appInstance = this;
    }

    async init() {
        await settingsManager.load();
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);

        const initSettings = settingsManager.get();
        sessionStore.init({
            engine: initSettings.translation_mode || 'soniox',
            sourceLang: initSettings.source_language || 'auto',
            targetLang: initSettings.target_language || 'vi',
        });

        this._syncUiSelectors();
        this._applySettings(settingsManager.get());
        this._bindEvents();
        this._bindKeyboardShortcuts();
        
        audioPlayer.init();
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onAudioChunk = (base64Audio) => { audioPlayer.enqueue(base64Audio); };
            tts.onError = (error) => { this._showToast(error, 'error'); };
        }

        console.log('🌐 ProSports interpreter initialized');
    }

    _syncUiSelectors() {
        const uiAppMode = document.getElementById('ui-select-app-mode');
        const uiSource = document.getElementById('ui-select-source-lang');
        const uiTarget = document.getElementById('ui-select-target-lang');
        
        const settingsAppMode = document.getElementById('select-app-mode');
        const bufferConfig = document.getElementById('presentation-buffer-config');
        const bufferSlider = document.getElementById('range-presentation-buffer');
        const bufferValue = document.getElementById('presentation-buffer-value');
        
        if (uiAppMode) uiAppMode.value = this.appMode;
        if (settingsAppMode) settingsAppMode.value = this.appMode;
        if (bufferConfig) bufferConfig.style.display = this.appMode === 'presentation' ? 'flex' : 'none';
        
        if (bufferSlider) {
            bufferSlider.value = this.presentationBufferTime / 1000;
            if (bufferValue) bufferValue.textContent = bufferSlider.value + 's';
            bufferSlider.addEventListener('input', (e) => {
                if (bufferValue) bufferValue.textContent = e.target.value + 's';
                this.presentationBufferTime = parseInt(e.target.value) * 1000;
                localStorage.setItem('my_presentation_buffer', this.presentationBufferTime.toString());
            });
        }
        
        const syncSettings = (newMode) => {
            if(newMode) {
                this.appMode = newMode;
                localStorage.setItem('my_app_mode', this.appMode);
                if(settingsAppMode) settingsAppMode.value = this.appMode;
                if(uiAppMode) uiAppMode.value = this.appMode;
                if(bufferConfig) bufferConfig.style.display = this.appMode === 'presentation' ? 'flex' : 'none';
            }
            if(uiSource && uiTarget) {
                document.getElementById('select-source-lang').value = uiSource.value;
                document.getElementById('select-target-lang').value = uiTarget.value;
                this._saveSettingsFromForm(true);
            }
        };

        uiAppMode?.addEventListener('change', (e) => syncSettings(e.target.value));
        settingsAppMode?.addEventListener('change', (e) => syncSettings(e.target.value));
        uiSource?.addEventListener('change', () => syncSettings());
        uiTarget?.addEventListener('change', () => syncSettings());
    }

    // ─── PRESENTATION MODE LOGIC ─────────────────────────────
    _handleIncomingTranscript(text, speaker, language) {
        if (!text || !text.trim()) return;
        this.presentationBuffer.push(text);
        if (this.presentationTimer) clearTimeout(this.presentationTimer);
        this.presentationTimer = setTimeout(() => this._processPresentationBuffer(), this.presentationBufferTime);
    }

    async _processPresentationBuffer() {
        if (this.presentationBuffer.length === 0) return;
        const fullTranscript = this.presentationBuffer.join(' ');
        this.presentationBuffer = [];

        this.transcriptUI.addOriginal(fullTranscript, "Presentation", "auto");
        const settings = settingsManager.get();
        if (!settings.openai_api_key) {
            this.transcriptUI.addTranslation("⚠️ Lỗi: Cần điền OpenAI API Key trong Settings để dùng Presentation Mode!");
            return;
        }

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openai_api_key}` },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "Dịch đoạn văn bản này sang ngôn ngữ đích thật tự nhiên, lưu loát, chuyên nghiệp. Chỉ trả về bản dịch." },
                        { role: "user", content: fullTranscript }
                    ],
                    temperature: 0.3
                })
            });
            const result = await response.json();
            if (result.choices && result.choices[0]) {
                const rewritten = result.choices[0].message.content.trim();
                this.transcriptUI.addTranslation(rewritten);
                sessionStore.addSegment(fullTranscript, rewritten);
            }
        } catch (err) { this.transcriptUI.addTranslation(`❌ Lỗi GPT API: ${err.message}`); }
    }

    // ─── AI ASSISTANT LOGIC ──────────────────────────────────
    async askAi(type) {
        const transcript = this.transcriptUI.getPlainText() || sessionStore.getFullText?.() || "";
        if (!transcript.trim()) { this._showToast("Chưa có nội dung hội thoại", "error"); return; }
        
        const promptMap = {
            'Summary': 'Tóm tắt nội dung chính của cuộc hội thoại.',
            'Explain': 'Giải thích chi tiết các thuật ngữ chuyên môn trong đoạn hội thoại.',
            'Action Items': 'Liệt kê các việc cần làm (action items) đã được thống nhất.'
        };
        
        const query = promptMap[type] || document.getElementById('ai-query').value;
        if(!query.trim()) return;

        this._addChatBubble('user', query);
        document.getElementById('ai-query').value = '';
        this._addChatBubble('ai', "Đang phân tích...");
        
        const answer = await this._callOpenAiChat(query, transcript);
        const history = document.getElementById('ai-chat-history');
        if(history.lastElementChild) {
            history.lastElementChild.innerHTML = answer; 
            history.scrollTop = history.scrollHeight;
        }
    }

    async _callOpenAiChat(query, context) {
        const settings = settingsManager.get();
        if(!settings.openai_api_key) return "Vui lòng nhập OpenAI API Key trong cài đặt.";
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openai_api_key}` },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "Bạn là trợ lý cho phần mềm ProSports interpreter. Dựa vào nội dung cuộc họp sau: " + context },
                        { role: "user", content: query }
                    ]
                })
            });
            const data = await response.json();
            return data.choices[0].message.content.replace(/\n/g, "<br>");
        } catch (e) { return "Lỗi kết nối AI: " + e.message; }
    }

    _addChatBubble(sender, text) {
        const history = document.getElementById('ai-chat-history');
        const bg = sender === 'user' ? '#ff6b4a' : '#2a2a2a';
        const align = sender === 'user' ? 'flex-end' : 'flex-start';
        history.innerHTML += `<div style="background:${bg}; padding:10px; border-radius:8px; align-self:${align}; max-width:90%; line-height: 1.4;">${text}</div>`;
        history.scrollTop = history.scrollHeight;
    }

    // ─── BIND EVENTS & CORE APP LOGIC ────────────────────────
    _bindEvents() {
        document.getElementById('btn-settings').addEventListener('click', () => this._showView('settings'));
        document.getElementById('btn-back').addEventListener('click', () => this._showView('overlay'));
        document.getElementById('btn-close').addEventListener('click', async () => { await this.stop(); await this.appWindow.close(); });
        document.getElementById('btn-minimize').addEventListener('click', async () => await this.appWindow.minimize());
        
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return;
            try {
                if (this.isRunning) await this.stop();
                else { this.isStarting = true; await this.start(); }
            } catch (err) { this._updateStartButton(); }
            finally { this.isStarting = false; }
        });

        // Nút bấm AI Assistant
        document.getElementById('btn-ai-magic').addEventListener('click', () => { document.getElementById('ai-assistant-panel').style.display = 'flex'; });
        document.getElementById('btn-close-ai').addEventListener('click', () => { document.getElementById('ai-assistant-panel').style.display = 'none'; });
        document.getElementById('btn-send-ai').addEventListener('click', () => this.askAi('custom'));
        document.getElementById('ai-query').addEventListener('keypress', (e) => { if(e.key === 'Enter') this.askAi('custom'); });

        document.getElementById('btn-source-system').addEventListener('click', () => this._setSource('system'));
        document.getElementById('btn-source-mic').addEventListener('click', () => this._setSource('microphone'));
        document.getElementById('btn-source-both').addEventListener('click', () => this._setSource('both'));
        
        document.getElementById('btn-clear').addEventListener('click', () => { this.transcriptUI.clear(); this.transcriptUI.showPlaceholder(); this.presentationBuffer = []; });
        
        document.getElementById('btn-save-settings').addEventListener('click', () => this._saveSettingsFromForm());
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => this._saveSettingsFromForm());

        // Tích hợp App Mode với Soniox
        this._sonioxOriginalQueue = [];
        sonioxClient.onOriginal = (text, speaker, language) => {
            if (this.appMode === 'presentation') {
                this._handleIncomingTranscript(text, speaker, language);
            } else {
                this.transcriptUI.addOriginal(text, speaker, language);
                this._sonioxOriginalQueue.push(text);
            }
        };

        sonioxClient.onTranslation = (text) => {
            if (this.appMode !== 'presentation') {
                this.transcriptUI.addTranslation(text);
                const src = this._sonioxOriginalQueue.shift() || '';
                sessionStore.addSegment(src, text);
            }
        };

        sonioxClient.onProvisional = (text, speaker, language) => {
            if (text && this.appMode === 'discussion') this.transcriptUI.setProvisional(text, speaker, language);
            else this.transcriptUI.clearProvisional();
        };

        sonioxClient.onStatusChange = (status) => this._updateStatus(status);
        sonioxClient.onError = (error) => this._showToast(error, 'error');
    }

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if(!this.isStarting) {
                    if (this.isRunning) this.stop(); else { this.isStarting = true; this.start().finally(()=> this.isStarting=false); }
                }
            }
        });
    }

    _showView(view) {
        document.getElementById('overlay-view').style.display = view === 'overlay' ? 'flex' : 'none';
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');
        if (view === 'settings') this._populateSettingsForm();
    }

    _populateSettingsForm() {
        const s = settingsManager.get();
        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        const openaiKeyInput = document.getElementById('input-openai-key');
        if (openaiKeyInput) openaiKeyInput.value = s.openai_api_key || '';
        
        const appModeSelect = document.getElementById('select-app-mode');
        if (appModeSelect) appModeSelect.value = this.appMode;
    }

    async _saveSettingsFromForm(silent = false) {
        const settings = {
            soniox_api_key: document.getElementById('input-api-key')?.value.trim() || '',
            openai_api_key: document.getElementById('input-openai-key')?.value.trim() || '',
            source_language: document.getElementById('select-source-lang')?.value || 'en',
            target_language: document.getElementById('select-target-lang')?.value || 'vi',
            translation_mode: document.getElementById('select-translation-mode')?.value || 'soniox',
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system'
        };

        try {
            await settingsManager.save(settings);
            if(!silent) { this._showToast('Settings saved', 'success'); this._showView('overlay'); }
        } catch (err) { this._showToast(`Failed to save: ${err}`, 'error'); }
    }

    _applySettings(settings) {
        this.currentSource = settings.audio_source || 'system';
        this._updateSourceButtons();
    }

    _setSource(source) {
        settingsManager.save({ audio_source: source });
        if (this.isRunning) { this.stop().then(() => { this.currentSource = source; this._updateSourceButtons(); this.start(); }); } 
        else { this.currentSource = source; this._updateSourceButtons(); }
    }

    _updateSourceButtons() {
        document.getElementById('btn-source-system').classList.toggle('active', this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active', this.currentSource === 'microphone');
        document.getElementById('btn-source-both').classList.toggle('active', this.currentSource === 'both');
    }

    async start() {
        const settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';

        if (this.translationMode === 'soniox' && !settings.soniox_api_key) { this._showToast('Soniox API key is required', 'error'); this._showView('settings'); return; }
        if (this.appMode === 'presentation' && !settings.openai_api_key) { this._showToast('OpenAI API key is required cho Presentation Mode', 'error'); this._showView('settings'); return; }

        this.isRunning = true;
        this._updateStartButton();

        sessionStore.beginChunk({ engine: this.translationMode, sourceLang: settings.source_language, targetLang: settings.target_language });

        if (!this.transcriptUI.hasContent()) this.transcriptUI.showListening();
        else this.transcriptUI.clearProvisional();

        const placeholder = document.querySelector('.transcript-placeholder');
        if(placeholder) placeholder.style.display = 'none';

        await this._startSonioxMode(settings);
    }

    async _startSonioxMode(settings) {
        this.transcriptUI.provider = 'soniox';
        this._updateStatus('connecting');
        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: settings.target_language,
            translationType: 'one_way'
        });

        try {
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => { sonioxClient.sendAudio(new Uint8Array(pcmData).buffer); };
            await invoke('start_capture', { source: this.currentSource, channel: channel });
        } catch (err) { this._showToast(`Audio error: ${err}`, 'error'); await this.stop(); }
    }

    async stop() {
        this.isRunning = false;
        this._updateStartButton();
        if (this.presentationTimer) clearTimeout(this.presentationTimer);

        try { await invoke('stop_capture'); } catch {}
        sonioxClient.disconnect();
        
        if (this.presentationBuffer.length > 0) { await this._processPresentationBuffer(); }
        sessionStore.endChunk();
        await sessionStore.persist();
        this._updateStatus('disconnected');
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');
        if(btn) btn.classList.toggle('recording', this.isRunning);
        if (iconPlay) iconPlay.style.display = this.isRunning ? 'none' : 'block';
        if (iconStop) iconStop.style.display = this.isRunning ? 'block' : 'none';
    }

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        if(!dot || !text) return;
        dot.className = 'status-dot';
        if (status === 'connecting') { dot.classList.add('connecting'); text.textContent = 'Connecting...'; }
        else if (status === 'connected') { dot.classList.add('connected'); text.textContent = 'Listening'; }
        else if (status === 'error') { dot.classList.add('error'); text.textContent = 'Error'; }
        else { dot.classList.add('disconnected'); text.textContent = 'Ready'; }
    }

    _showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = `toast ${type}`; toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
    }
}

document.addEventListener('DOMContentLoaded', () => { new App().init(); });