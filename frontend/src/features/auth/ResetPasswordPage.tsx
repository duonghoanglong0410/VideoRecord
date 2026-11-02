import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { KeyRound, Mail } from 'lucide-react';
import { apiRequest, ApiRequestError } from '../../app/apiClient';
import { useAuth } from '../../app/authStore';
import { StorageModeBanner } from '../../app/StorageModeBanner';

export function ResetPasswordPage() {
  const { runtimeConfig } = useAuth();
  const [searchParams] = useSearchParams();

  const initialEmail = searchParams.get('email') ?? '';
  const initialToken = searchParams.get('token') ?? '';

  const [mode, setMode] = useState<'request' | 'confirm'>(
    initialToken ? 'confirm' : 'request'
  );

  const [email, setEmail] = useState(initialEmail);
  const [token, setToken] = useState(initialToken);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleRequestEmail = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const res = await apiRequest<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
        suppressSessionExpiredEvent: true
      });
      setSuccessMessage(res.message);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Không thể gửi yêu cầu đặt lại mật khẩu.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmReset = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (newPassword !== confirmPassword) {
      setErrorMessage('Mật khẩu nhập lại chưa khớp.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: {
          email: email.trim(),
          token: token.trim(),
          newPassword,
          confirmPassword
        },
        suppressSessionExpiredEvent: true
      });
      setSuccessMessage(res.message);
      setToken('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Đặt lại mật khẩu chưa thành công.');
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
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              PackingProof Web
            </span>
            <h1 className="brand-title">Đặt lại mật khẩu</h1>
            <p className="brand-subtitle">
              Nhận mã qua Email hoặc nhập mã khôi phục do Quản lý cấp trực tiếp.
            </p>
          </div>

          <div className="segmented-tabs mb-4 grid w-full grid-cols-2">
            <button
              type="button"
              className={`segmented-tab ${mode === 'request' ? 'active' : ''}`}
              onClick={() => {
                setMode('request');
                setErrorMessage(null);
                setSuccessMessage(null);
              }}
            >
              Gửi qua Email
            </button>
            <button
              type="button"
              className={`segmented-tab ${mode === 'confirm' ? 'active' : ''}`}
              onClick={() => {
                setMode('confirm');
                setErrorMessage(null);
                setSuccessMessage(null);
              }}
            >
              Đã có mã đặt lại
            </button>
          </div>

          {errorMessage && (
            <div className="alert alert-error" role="alert">
              {errorMessage}
            </div>
          )}

          {successMessage && (
            <div className="alert alert-success" role="status">
              {successMessage}
            </div>
          )}

          {mode === 'request' ? (
            <form onSubmit={(e) => void handleRequestEmail(e)}>
              <div className="form-group">
                <label className="form-label" htmlFor="forgot-email">
                  Địa chỉ Email tài khoản
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  className="form-input"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nhanvien@congty.vn"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={isSubmitting}
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                {isSubmitting ? 'Đang xử lý...' : 'Gửi hướng dẫn đặt lại mật khẩu'}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleConfirmReset(e)}>
              <div className="form-group">
                <label className="form-label" htmlFor="reset-email">
                  Địa chỉ Email tài khoản
                </label>
                <input
                  id="reset-email"
                  type="email"
                  className="form-input"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="reset-token">
                  Mã đặt lại mật khẩu một lần
                </label>
                <input
                  id="reset-token"
                  type="text"
                  className="form-input font-mono"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Dán mã do Quản lý hoặc Email cung cấp"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="reset-new-password">
                  Mật khẩu mới
                </label>
                <input
                  id="reset-new-password"
                  type="password"
                  className="form-input"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Tối thiểu 8 ký tự (chữ hoa, thường, số)"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="reset-confirm-password">
                  Nhập lại mật khẩu mới
                </label>
                <input
                  id="reset-confirm-password"
                  type="password"
                  className="form-input"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={isSubmitting}
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                {isSubmitting ? 'Đang cập nhật...' : 'Đặt mật khẩu mới'}
              </button>
            </form>
          )}

          <div className="auth-links">
            <Link to="/login">Quay lại trang đăng nhập</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
