/**
 * Minimal HTTP client for the literature sources.
 *
 * Node's global fetch already handles redirects and TLS; this module adds the
 * three things public scholarly APIs actually need: a descriptive User-Agent,
 * per-host rate limiting (arXiv asks for one request every 3 seconds, NCBI for
 * at most three per second without an API key), and bounded retries with
 * exponential backoff. Every request forwards the caller's AbortSignal so a
 * cancelled tool call stops promptly.
 */

const USER_AGENT =
  'dsh-plugin-medical-literature/0.6 (DeepSeek Harness medical literature plugin)'

/** Politeness floor per host, in milliseconds. */
const HOST_MIN_INTERVAL_MS = {
  'eutils.ncbi.nlm.nih.gov': 350,
  'pmc.ncbi.nlm.nih.gov': 350,
  'www.ebi.ac.uk': 150,
  'export.arxiv.org': 3000,
  'arxiv.org': 1000,
  'api.crossref.org': 250,
}

/** Last request start time per host. */
const lastRequestAt = new Map()
/** Tail of the per-host slot queue, so concurrent callers never race the floor. */
const hostQueues = new Map()

/** Build an AbortError without depending on DOMException availability. */
function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError')
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Hostname of a URL, or a stable fallback for malformed input. */
export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
}

function parseRetryAfter(value) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function backoffMs(attempt) {
  return 750 * 2 ** attempt
}

/**
 * Wait for this host's next legal slot and claim it.
 * The queue makes concurrent callers observe the interval in call order.
 */
async function acquireSlot(host, interval, signal) {
  const previous = hostQueues.get(host) ?? Promise.resolve()
  let release = () => {}
  const mine = new Promise((resolve) => {
    release = resolve
  })
  hostQueues.set(host, previous.then(() => mine))
  await previous
  try {
    const wait = (lastRequestAt.get(host) ?? 0) + interval - Date.now()
    if (wait > 0) await sleep(wait, signal)
    lastRequestAt.set(host, Date.now())
  } finally {
    release()
  }
}

/**
 * Fetch a URL with politeness, timeout, and retries.
 *
 * Retries 429 and 5xx responses (honouring Retry-After) and transient network
 * failures. Timeouts and caller cancellation are never retried.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {number} [options.timeoutMs] per-attempt timeout, default 30000
 * @param {Record<string, string>} [options.headers] extra request headers
 * @param {number} [options.minInterval] per-host interval override
 * @param {number} [options.retries] retry count after the first attempt, default 2
 * @returns {Promise<Response>} a successful response
 */
export async function request(url, options = {}) {
  const {
    signal,
    timeoutMs = 30_000,
    headers = {},
    minInterval = HOST_MIN_INTERVAL_MS[hostOf(url)] ?? 200,
    retries = 2,
  } = options
  const host = hostOf(url)
  let lastError

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw abortError()
    await acquireSlot(host, minInterval, signal)

    let response
    try {
      response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
        signal: combineSignals(signal, timeoutMs),
        redirect: 'follow',
      })
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (error?.name === 'TimeoutError') {
        throw new Error(`Request to ${host} timed out after ${timeoutMs}ms`)
      }
      lastError = error
      if (attempt < retries) {
        await sleep(backoffMs(attempt), signal)
        continue
      }
      throw new Error(`Request to ${host} failed: ${error?.message ?? String(error)}`)
    }

    if (response.ok) return response

    const body = await response.text().catch(() => '')
    lastError = new Error(
      `HTTP ${response.status} ${response.statusText} from ${host}${body ? `: ${body.slice(0, 300)}` : ''}`,
    )
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      await sleep(retryAfter ?? backoffMs(attempt), signal)
      continue
    }
    throw lastError
  }

  throw lastError ?? new Error(`Request to ${host} failed`)
}

/** Fetch and parse a JSON document, with a readable error when it is not JSON. */
export async function requestJson(url, options = {}) {
  const response = await request(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Expected JSON from ${hostOf(url)} but received: ${text.slice(0, 200)}`)
  }
}

/** Fetch a text document (XML feeds, MEDLINE batches). */
export async function requestText(url, options = {}) {
  const response = await request(url, {
    ...options,
    headers: { accept: 'application/xml,text/xml,text/plain,*/*', ...options.headers },
  })
  return response.text()
}
