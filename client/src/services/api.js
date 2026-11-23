import axios from "axios";

const defaultApiUrl = `${window.location.protocol}//${window.location.hostname}:5000/api`;

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || defaultApiUrl,
  timeout: 10000,
  withCredentials: true
});

export const apiOrigin = (api.defaults.baseURL || "").replace(/\/api\/?$/, "");
export const gamePlayUrl = (slug) => `${apiOrigin}/games/play/${encodeURIComponent(slug)}`;
export const gamePreviewUrl = (id) => `${apiOrigin}/api/games/${encodeURIComponent(id)}/preview`;

let csrfToken = null;
let csrfPromise = null;

async function loadCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  if (csrfPromise && !force) return csrfPromise;

  csrfPromise = api.get("/auth/csrf").then(({ data }) => {
    csrfToken = data.csrfToken;
    return csrfToken;
  }).finally(() => {
    csrfPromise = null;
  });
  return csrfPromise;
}

api.interceptors.request.use(async (config) => {
  if (["post", "put", "patch", "delete"].includes(config.method?.toLowerCase())) {
    config.headers["x-csrf-token"] = await loadCsrfToken();
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (
      error.response?.status === 403 &&
      error.response?.data?.message === "Invalid CSRF token" &&
      !originalRequest?._csrfRetried
    ) {
      originalRequest._csrfRetried = true;
      originalRequest.headers["x-csrf-token"] = await loadCsrfToken(true);
      return api(originalRequest);
    }
    return Promise.reject(error);
  }
);

export default api;
