import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  apiRequest,
  ApiRequestError,
  SESSION_EXPIRED_EVENT,
  setCsrfToken
} from './apiClient';
import type { AuthMe, LoginResponse, RuntimeConfig } from './types';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface LoginInput {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface Login2FaInput {
  code: string;
  useRecoveryCode?: boolean;
  rememberMe?: boolean;
}

export interface AuthContextValue {
  user: AuthMe | null;
  runtimeConfig: RuntimeConfig | null;
  isLoading: boolean;
  sessionExpiredNotice: string | null;
  clearSessionExpiredNotice: () => void;
  hasPermission: (permissionCode: string) => boolean;
  refreshMe: () => Promise<AuthMe | null>;
  login: (input: LoginInput) => Promise<LoginResponse>;
  loginTwoFactor: (input: Login2FaInput) => Promise<LoginResponse>;
  register: (input: RegisterInput) => Promise<AuthMe>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthMe | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState<string | null>(null);

  const applyMe = useCallback((me: AuthMe | null) => {
    setUser(me);
    if (me?.runtimeConfig) {
      setRuntimeConfig(me.runtimeConfig);
    }
    if (me?.csrfToken) {
      setCsrfToken(me.csrfToken);
    }
  }, []);

  const refreshMe = useCallback(async (): Promise<AuthMe | null> => {
    try {
      const me = await apiRequest<AuthMe>('/api/auth/me', {
        method: 'GET',
        suppressSessionExpiredEvent: true
      });
      applyMe(me);
      return me;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setUser(null);
        return null;
      }
      setUser(null);
      return null;
    }
  }, [applyMe]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await apiRequest<AuthMe>('/api/auth/me', {
          method: 'GET',
          suppressSessionExpiredEvent: true
        });
        if (active) {
          applyMe(me);
        }
      } catch {
        if (active) {
          setUser(null);
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [applyMe]);

  useEffect(() => {
    const onSessionExpired = () => {
      setUser(null);
      setSessionExpiredNotice(
        'Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Dữ liệu video lưu tạm trên thiết bị vẫn được giữ nguyên — vui lòng đăng nhập lại đúng tài khoản để tiếp tục.'
      );
    };

    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, []);

  const login = useCallback(
    async (input: LoginInput): Promise<LoginResponse> => {
      const res = await apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: input,
        suppressSessionExpiredEvent: true
      });
      if (!res.requiresTwoFactor && res.user) {
        setSessionExpiredNotice(null);
        applyMe(res.user);
      }
      return res;
    },
    [applyMe]
  );

  const loginTwoFactor = useCallback(
    async (input: Login2FaInput): Promise<LoginResponse> => {
      const res = await apiRequest<LoginResponse>('/api/auth/login-2fa', {
        method: 'POST',
        body: input,
        suppressSessionExpiredEvent: true
      });
      if (res.user) {
        setSessionExpiredNotice(null);
        applyMe(res.user);
      }
      return res;
    },
    [applyMe]
  );

  const register = useCallback(
    async (input: RegisterInput): Promise<AuthMe> => {
      const me = await apiRequest<AuthMe>('/api/auth/register', {
        method: 'POST',
        body: input,
        suppressSessionExpiredEvent: true
      });
      setSessionExpiredNotice(null);
      applyMe(me);
      return me;
    },
    [applyMe]
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiRequest('/api/auth/logout', {
        method: 'POST',
        body: {},
        suppressSessionExpiredEvent: true
      });
    } finally {
      setUser(null);
    }
  }, []);

  const hasPermission = useCallback(
    (permissionCode: string): boolean => {
      if (!user || user.approvalStatus !== 'Active') {
        return false;
      }
      return user.permissions.includes(permissionCode);
    },
    [user]
  );

  const clearSessionExpiredNotice = useCallback(() => {
    setSessionExpiredNotice(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      runtimeConfig,
      isLoading,
      sessionExpiredNotice,
      clearSessionExpiredNotice,
      hasPermission,
      refreshMe,
      login,
      loginTwoFactor,
      register,
      logout
    }),
    [
      user,
      runtimeConfig,
      isLoading,
      sessionExpiredNotice,
      clearSessionExpiredNotice,
      hasPermission,
      refreshMe,
      login,
      loginTwoFactor,
      register,
      logout
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return ctx;
}

