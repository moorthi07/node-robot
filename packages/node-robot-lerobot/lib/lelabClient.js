/**
 * Thin HTTP client for the leLab FastAPI service.
 *
 * leLab (github.com/huggingface/leLab, Apache-2.0) is the official LeRobot web
 * UI + API. We wrap it rather than reimplement it: every route below was read
 * off leLab's server.py, not guessed. The base URL comes from the
 * lerobot-config node, which is how "where does LeRobot run" is answered — it
 * can point at a local sidecar or a remote GPU box.
 *
 * Uses the global fetch built into Node 18+, so this collection adds no npm
 * dependency of its own.
 */

'use strict';

class LelabClient {
  /** @param {string} baseUrl e.g. http://localhost:8000 */
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || 'http://localhost:8000').replace(/\/+$/, '');
  }

  /**
   * One request helper for every call. Surfaces leLab's own error `detail`
   * (FastAPI's HTTPException shape) rather than a bare status code, and applies
   * a timeout so a hung backend doesn't wedge a flow forever.
   *
   * @param {number} [timeoutMs] default 30s; recording/training kickoffs return
   *   quickly (they spawn background work), so this is about connect/response,
   *   not job duration.
   */
  async request(method, path, body, timeoutMs = 30000) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      if (!res.ok) {
        const detail = (data && (data.detail || data.message)) || res.statusText;
        const err = new Error(`leLab ${method} ${path} -> ${res.status}: ${detail}`);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`leLab ${method} ${path} timed out after ${timeoutMs}ms (is the backend at ${this.baseUrl} reachable?)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Health ──────────────────────────────────────────────────────────────
  health() { return this.request('GET', '/health'); }

  // ── Recording (leLab RecordingRequest shape) ──────────────────────────────
  startRecording(req) { return this.request('POST', '/start-recording', req); }
  stopRecording() { return this.request('POST', '/stop-recording'); }
  recordingStatus() { return this.request('GET', '/recording-status'); }
  recordingExitEarly() { return this.request('POST', '/recording-exit-early'); }
  recordingReRecord() { return this.request('POST', '/recording-rerecord-episode'); }

  // ── Datasets / browsing / replay ──────────────────────────────────────────
  listDatasets() { return this.request('GET', '/datasets'); }
  datasetInfo(datasetRepoId) { return this.request('POST', '/dataset-info', { dataset_repo_id: datasetRepoId }); }
  deleteDataset(datasetRepoId) { return this.request('POST', '/delete-dataset', { dataset_repo_id: datasetRepoId }); }
  uploadDataset(req) { return this.request('POST', '/upload-dataset', req); }
  datasetEpisodes(query) { return this.request('GET', `/dataset-episodes${qs(query)}`); }
  datasetEpisode(query) { return this.request('GET', `/dataset-episode${qs(query)}`); }

  // ── Policy: inference + training ──────────────────────────────────────────
  startInference(req) { return this.request('POST', '/start-inference', req); }
  stopInference() { return this.request('POST', '/stop-inference'); }
  inferenceStatus() { return this.request('GET', '/inference-status'); }
  startTraining(req) { return this.request('POST', '/jobs/training', req); }
  listJobs() { return this.request('GET', '/jobs'); }
  job(jobId) { return this.request('GET', `/jobs/${encodeURIComponent(jobId)}`); }
  stopJob(jobId) { return this.request('POST', `/jobs/${encodeURIComponent(jobId)}/stop`); }

  // ── Calibration ───────────────────────────────────────────────────────────
  startCalibration(req) { return this.request('POST', '/start-calibration', req); }
  stopCalibration() { return this.request('POST', '/stop-calibration'); }
  calibrationStatus() { return this.request('GET', '/calibration-status'); }
  completeCalibrationStep() { return this.request('POST', '/complete-calibration-step'); }

  /** Absolute URL for the embedded UI iframe and for MJPEG camera feeds. */
  uiUrl() { return this.baseUrl; }
  cameraFeedUrl(camKey) { return `${this.baseUrl}/camera-feed/${encodeURIComponent(camKey)}`; }
}

/** Build a query string from a plain object; '' when empty. */
function qs(obj) {
  if (!obj) return '';
  const parts = Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

module.exports = { LelabClient };
