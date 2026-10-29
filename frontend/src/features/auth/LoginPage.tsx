import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
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
        setErrorMessage('Xác thực hai lớp thất bại. Vui lòng thử lại.');
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
            <span className="brand-badge">PackingProof Web</span>
            <h1 className="brand-title">
              {requiresTwoFactor ? 'Xác thực hai lớp (2FA)' : 'Đăng nhập hệ thống'}
            </h1>
            <p className="brand-subtitle">
              {requiresTwoFactor
                ? 'Nhập mã xác thực từ ứng dụng Authenticator hoặc mã khôi phục dự phòng.'
                : 'Quét mã vận đơn, quay đóng gói và lưu trữ video đối soát.'}
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
                <input
                  id="login-password"
                  type="password"
                  className="form-input"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Nhập mật khẩu"
                />
              </div>

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="login-remember"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  style={{ width: 20, height: 20 }}
                />
                <label htmlFor="login-remember" style={{ fontSize: '0.92rem' }}>
                  Duy trì phiên đăng nhập trên thiết bị này
                </label>
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Đang đăng nhập...' : 'Đăng nhập'}
              </button>

              <div className="auth-links">
                <Link to="/register">Chưa có tài khoản? Đăng ký chờ duyệt</Link>
                <Link to="/reset-password">Quên hoặc đặt lại mật khẩu</Link>
              </div>
            </form>
          ) : (
            <form onSubmit={(e) => void handleTwoFactorSubmit(e)}>
              <div className="form-group">
                <label className="form-label" htmlFor="totp-code">
                  {useRecoveryCode
                    ? 'Mã khôi phục dự phòng một lần'
                    : 'Mã xác thực 6 chữ số (TOTP)'}
                </label>
                <input
                  id="totp-code"
                  type="text"
                  inputMode={useRecoveryCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  className="form-input"
                  required
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  placeholder={useRecoveryCode ? 'Ví dụ: ABCD-EFGH' : 'Nhập 6 chữ số'}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  type="submit"
                  className="btn btn-primary btn-full"
                  disabled={isSubmitting}
                >
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

