/**
 * API Service
 *
 * A clean, reusable API client built on axios with:
 * - Type safety
 * - CSRF protection for Laravel Sanctum
 * - Automatic error handling
 * - Request/response interceptors
 * - Centralized configuration
 */

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig
} from "axios";
import { toast } from "@/components/ui/use-toast";
import API_CONFIG_IMPORT, {
  getGlobalHeaders
} from "./config";

// Use the imported config
const API_CONFIG = API_CONFIG_IMPORT;

/**
 * Type definitions for better type safety
 * These types provide more specific constraints than 'any'
 */

// Request parameters type (for query strings)
export type ApiParams = Record<string, unknown>;

// Request data type (for request bodies)
export type ApiData =
  | Record<string, unknown>
  | FormData
  | string
  | number
  | boolean
  | null
  | undefined;

export interface ApiErrorResponse {
  message?: string;
  error?: string;
  errors?: Record<string, string[]>;
  status?: number;
}

/**
 * CSRF Token Management
 * Handles fetching and refreshing CSRF tokens for Laravel Sanctum
 */
class CsrfTokenManager {
  private xsrfTokenValue: string | null = null;

  /**
   * Fetch a fresh CSRF token from the server
   */
  public async fetchToken(): Promise<void> {
    try {
      // Extract base URL (removing /api if present)
      const baseUrl = API_CONFIG.BASE_URL.replace(/\/api\/?$/, '');

      // Make sure baseUrl is the actual domain root for proper cookie setting
      const baseUrlObj = new URL(baseUrl, window.location.origin);
      const csrfUrl = `${baseUrlObj.origin}/sanctum/csrf-cookie`;

      console.log('Fetching CSRF token from:', csrfUrl);

      // Make request to Sanctum endpoint
      const response = await fetch(csrfUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Cache-Control': 'no-cache, no-store',
          ...getGlobalHeaders(),
        },
      });

      if (!response.ok) {
        throw new Error(`CSRF token fetch failed: ${response.status}`);
      }

      // Extract the CSRF token from cookies
      const xsrfCookie = this.getXsrfCookieFromDocument();
      if (xsrfCookie) {
        const tokenParts = xsrfCookie.split('=');
        if (tokenParts.length > 1) {
          this.xsrfTokenValue = decodeURIComponent(tokenParts[1]);
          console.log('CSRF token refreshed successfully');
        } else {
          console.error('CSRF token format invalid:', xsrfCookie);
        }
      } else {
        console.error('No XSRF cookie found after fetch');
      }

      if (API_CONFIG.DEBUG) {
        console.log('CSRF token refreshed successfully');
      }
    } catch (error) {
      console.error('CSRF token fetch error:', error);
      throw error;
    }
  }

  /**
   * Get the current CSRF token value
   */
  public getToken(): string | null {
    return this.xsrfTokenValue;
  }

  /**
   * Helper method to get XSRF cookie from document
   */
  private getXsrfCookieFromDocument(): string | undefined {
    const cookies = document.cookie.split(';');
    const xsrfCookie = cookies.find(cookie => cookie.trim().startsWith('XSRF-TOKEN='));
    if (xsrfCookie) {
      console.log('Found XSRF cookie:', xsrfCookie);
    } else {
      console.log('No XSRF cookie found in document.cookie');
      console.log('All cookies:', document.cookie);
    }
    return xsrfCookie;
  }
}

/**
 * HTTP Client
 * Wraps axios with custom configuration and interceptors
 */
class HttpClient {
  private instance: AxiosInstance;
  private csrfManager: CsrfTokenManager;

  constructor() {
    // Create CSRF manager
    this.csrfManager = new CsrfTokenManager();

    // Create axios instance with default config
    this.instance = axios.create({
      baseURL: API_CONFIG.BASE_URL,
      timeout: API_CONFIG.TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      withCredentials: true, // Always include credentials for CSRF to work
      withXSRFToken: true,
    });

    // Set up interceptors
    this.setupInterceptors();
  }

  /**
   * Configure request and response interceptors
   */
  private setupInterceptors(): void {
    // Request interceptor
    this.instance.interceptors.request.use(
      async (config: InternalAxiosRequestConfig) => {
        // Add auth token if available
        const token = localStorage.getItem('auth_token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }

        // Add global headers
        const globalHeaders = getGlobalHeaders();
        Object.keys(globalHeaders).forEach(key => {
          config.headers[key] = globalHeaders[key];
        });

        // Explicitly add CSRF token if available
        const csrfToken = this.csrfManager.getToken();
        if (csrfToken) {
          config.headers['X-XSRF-TOKEN'] = csrfToken;
        }

        // Log request in debug mode
        if (API_CONFIG.DEBUG) {
          console.log(`🚀 Request: ${config.method?.toUpperCase()} ${config.url}`, {
            params: config.params,
            data: config.data,
            headers: config.headers
          });
        }

        return config;
      },
      (error) => {
        console.error('Request error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.instance.interceptors.response.use(
      (response) => {
        // Log response in debug mode
        if (API_CONFIG.DEBUG) {
          console.log(`✅ Response: ${response.config.method?.toUpperCase()} ${response.config.url}`, {
            status: response.status,
            data: response.data
          });
        }

        return response;
      },
      async (error: AxiosError) => {
        const response = error.response;

        // Handle HTML responses (usually server errors)
        if (response?.data && typeof response.data === 'string' && response.data.includes('<!DOCTYPE')) {
          toast({
            title: 'Server Error',
            description: 'Invalid HTML response from server. Contact support.',
            variant: 'destructive',
          });
          return Promise.reject(new Error('Invalid HTML response received'));
        }

        // Extract error message
        const responseData = response?.data as ApiErrorResponse | undefined;
        const message = responseData?.message ||
          responseData?.error ||
          'An unexpected error occurred';

        // Handle CSRF token expiry (status 419)
        if (response?.status === 419) {
          try {
            await this.csrfManager.fetchToken();
            // Retry the original request
            return this.instance(error.config as AxiosRequestConfig);
          } catch (csrfError) {
            console.error('CSRF token refresh failed:', csrfError);
          }
        }

        // Handle authentication errors (status 401)
        if (response?.status === 401) {
          localStorage.removeItem('auth_token');
          if (!window.location.pathname.includes('/login')) {
            window.location.href = '/login?session=expired';
          }
        }

        // Show toast for all errors except validation errors (status 422)
        if (response?.status !== 422) {
          toast({
            title: 'Error',
            description: message,
            variant: 'destructive',
          });
        }

        // Log error in debug mode
        if (API_CONFIG.DEBUG) {
          console.error(`❌ API Error: ${error.config?.method?.toUpperCase()} ${error.config?.url}`, {
            status: response?.status,
            data: response?.data
          });
        }

        return Promise.reject(error);
      }
    );
  }

  /**
   * Get the underlying axios instance
   */
  public getAxiosInstance(): AxiosInstance {
    return this.instance;
  }

  /**
   * Fetch CSRF token
   */
  public async fetchCsrfToken(): Promise<void> {
    return this.csrfManager.fetchToken();
  }

  /**
   * Make a GET request
   */
  public async get<T = unknown>(url: string, params?: ApiParams): Promise<T> {
    const response = await this.instance.get<T>(url, { params });
    return response.data;
  }

  /**
   * Make a POST request
   */
  public async post<T = unknown>(url: string, data?: ApiData): Promise<T> {
    // Fetch CSRF token before POST requests
    await this.fetchCsrfToken();

    try {
      const response = await this.instance.post<T>(url, data);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 419 ||
        (axiosError.response?.data as ApiErrorResponse)?.message === 'CSRF token mismatch.') {
        console.log('CSRF token mismatch detected, retrying with fresh token');
        // Try once more with a fresh token
        await this.fetchCsrfToken();
        const response = await this.instance.post<T>(url, data);
        return response.data;
      }
      throw error;
    }
  }

  /**
   * Make a PUT request
   */
  public async put<T = unknown>(url: string, data?: ApiData): Promise<T> {
    // Fetch CSRF token before PUT requests
    await this.fetchCsrfToken();
    const response = await this.instance.put<T>(url, data);
    return response.data;
  }

  /**
   * Make a PATCH request
   */
  public async patch<T = unknown>(url: string, data?: ApiData): Promise<T> {
    // Fetch CSRF token before PATCH requests
    await this.fetchCsrfToken();
    const response = await this.instance.patch<T>(url, data);
    return response.data;
  }

  /**
   * Make a DELETE request
   */
  public async delete<T = unknown>(url: string): Promise<T> {
    // Fetch CSRF token before DELETE requests
    await this.fetchCsrfToken();
    const response = await this.instance.delete<T>(url);
    return response.data;
  }

  /**
   * Upload a file
   */
  public async uploadFile<T = unknown>(url: string, formData: FormData): Promise<T> {
    // Fetch CSRF token before file uploads
    await this.fetchCsrfToken();

    const config: AxiosRequestConfig = {
      headers: { 'Content-Type': 'multipart/form-data' }
    };

    const response = await this.instance.post<T>(url, formData, config);
    return response.data;
  }
}

// Create and export a singleton instance
const httpClient = new HttpClient();

// Export the API service with all methods
const apiService = {
  get: <T = unknown>(url: string, params?: ApiParams) =>
    httpClient.get<T>(url, params),

  post: <T = unknown>(url: string, data?: ApiData) =>
    httpClient.post<T>(url, data),

  put: <T = unknown>(url: string, data?: ApiData) =>
    httpClient.put<T>(url, data),

  patch: <T = unknown>(url: string, data?: ApiData) =>
    httpClient.patch<T>(url, data),

  delete: <T = unknown>(url: string) =>
    httpClient.delete<T>(url),

  uploadFile: <T = unknown>(url: string, formData: FormData) =>
    httpClient.uploadFile<T>(url, formData),

  // For backward compatibility and advanced use cases
  fetchCsrfToken: () => httpClient.fetchCsrfToken(),
  getAxiosInstance: () => httpClient.getAxiosInstance(),
  axios: httpClient.getAxiosInstance(),
};

// Export for use in other modules
export default apiService;

// Export the getCsrfToken function for backward compatibility
export const getCsrfToken = () => httpClient.fetchCsrfToken();
