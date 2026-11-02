import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, LogIn, PackageCheck, ShieldCheck } from 'lucide-react';
import { ApiRequestError } from '../../app/apiClient';
import { useAuth } from '../../app/authStore';
import { StorageModeBanner } from '../../app/StorageModeBanner';

export function LoginPage() {
  const {
    user,
    runtimeConfig,
    sessionExpiredNotice,
    clearSessionExpiredNotice,
    login,
    loginTwoFactor
  } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (user) {
    if (user.approvalStatus === 'PendingApproval') {
      return <Navigate to="/pending-approval" replace />;
    }
    return <Navigate to="/" replace />;
  }

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    clearSessionExpiredNotice();
    setIsSubmitting(true);

    try {
      const response = await login({ email: email.trim(), password, rememberMe });
      if (response.requiresTwoFactor) {
        setRequiresTwoFactor(true);
        setTwoFactorCode('');
        return;
      }

      if (response.user?.approvalStatus === 'PendingApproval') {
        navigate('/pending-approval', { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Không thể kết nối máy chủ. Vui lòng thử lại.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTwoFactorSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await loginTwoFactor({
        code: twoFactorCode.trim(),
        useRecoveryCode,
        rememberMe
      });

      if (response.user?.approvalStatus === 'PendingApproval') {
        navigate('/pending-approval', { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Mã xác thực chưa đúng. Vui lòng kiểm tra lại.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <StorageModeBanner storageMode={runtimeConfig?.storageMode} />

      <div className="auth-container">
        <div className="auth-card">
          <div className="brand-header">
            <span className="brand-badge">
              {requiresTwoFactor ? (
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              PackingProof Web
            </span>
            <h1 className="brand-title">
              {requiresTwoFactor ? 'Xác thực hai lớp (2FA)' : 'Đăng nhập hệ thống'}
            </h1>
            <p className="brand-subtitle">
              {requiresTwoFactor
                ? 'Nhập mã từ ứng dụng bảo mật trên điện thoại hoặc dùng mã khôi phục dự phòng.'
                : 'Hệ thống quay và tra cứu video đóng gói đơn hàng.'}
            </p>
          </div>

          {sessionExpiredNotice && (
            <div className="alert alert-warning" role="alert">
              {sessionExpiredNotice}
            </div>
          )}

          {errorMessage && (
            <div className="alert alert-error" role="alert">
              {errorMessage}
            </div>
          )}

          {!requiresTwoFactor ? (
            <form onSubmit={(e) => void handlePasswordSubmit(e)}>
              <div className="form-group">
                <label className="form-label" htmlFor="login-email">
                  Địa chỉ Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  className="form-input"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nhanvien@congty.vn"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="login-password">
                  Mật khẩu
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    className="form-input pr-12"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Nhập mật khẩu của bạn"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute top-1/2 right-1 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="login-remember" className="checkbox-inline-row">
                  <input
                    id="login-remember"
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                  />
                  <span>Ghi nhớ đăng nhập trên thiết bị này</span>
                </label>
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={isSubmitting}
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {isSubmitting ? 'Đang đăng nhập...' : 'Đăng nhập'}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleTwoFactorSubmit(e)}>
              <div className="form-group">
                <label className="form-label" htmlFor="totp-code">
                  {useRecoveryCode
                    ? 'Mã khôi phục dự phòng một lần'
                    : 'Mã xác thực 6 chữ số'}
                </label>
                <input
                  id="totp-code"
                  type="text"
                  inputMode={useRecoveryCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  className="form-input font-mono text-center text-lg tracking-widest"
                  required
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  placeholder={useRecoveryCode ? 'ABCD-EFGH' : '000000'}
                />
              </div>

              <div className="flex flex-col gap-2.5">
                <button
                  type="submit"
                  className="btn btn-primary btn-full"
                  disabled={isSubmitting}
                >
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  {isSubmitting ? 'Đang xác minh...' : 'Xác minh mã 2FA'}
                </button>

                <button
                  type="button"
                  className="btn btn-outline btn-full"
                  onClick={() => {
                    setUseRecoveryCode((prev) => !prev);
                    setTwoFactorCode('');
                    setErrorMessage(null);
                  }}
                >
                  {useRecoveryCode
                    ? 'Dùng mã ứng dụng Authenticator'
                    : 'Dùng mã khôi phục dự phòng'}
                </button>

                <button
                  type="button"
                  className="btn btn-outline btn-full"
                  onClick={() => {
                    setRequiresTwoFactor(false);
                    setTwoFactorCode('');
                    setUseRecoveryCode(false);
                    setErrorMessage(null);
                  }}
                >
                  Quay lại bước nhập mật khẩu
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
