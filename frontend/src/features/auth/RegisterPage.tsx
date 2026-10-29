import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../../app/apiClient';
import { useAuth } from '../../app/authStore';
import { StorageModeBanner } from '../../app/StorageModeBanner';

export function RegisterPage() {
  const { user, runtimeConfig, register } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (user) {
    if (user.approvalStatus === 'PendingApproval') {
      return <Navigate to="/pending-approval" replace />;
    }
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setErrorDetails([]);

    if (password !== confirmPassword) {
      setErrorMessage('Mật khẩu xác nhận không khớp.');
      return;
    }

    setIsSubmitting(true);
    try {
      await register({
        name: name.trim(),
        email: email.trim(),
        password,
        confirmPassword
      });
      navigate('/pending-approval', { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMessage(err.message);
        setErrorDetails(err.details);
      } else {
        setErrorMessage('Đăng ký không thành công. Vui lòng thử lại.');
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
            <h1 className="brand-title">Đăng ký tài khoản mới</h1>
            <p className="brand-subtitle">
              Tài khoản sau khi tạo sẽ ở trạng thái Chờ phê duyệt cho đến khi Quản trị viên cấp
              vai trò và phạm vi Shop/Kho.
            </p>
          </div>

          {errorMessage && (
            <div className="alert alert-error" role="alert">
              <div>{errorMessage}</div>
              {errorDetails.length > 1 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {errorDetails.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)}>
            <div className="form-group">
              <label className="form-label" htmlFor="reg-name">
                Họ và tên nhân viên
              </label>
              <input
                id="reg-name"
                type="text"
                className="form-input"
                autoComplete="name"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nguyễn Văn A"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="reg-email">
                Địa chỉ Email
              </label>
              <input
                id="reg-email"
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
              <label className="form-label" htmlFor="reg-password">
                Mật khẩu (tối thiểu 8 ký tự, gồm chữ hoa, chữ thường và số)
              </label>
              <input
                id="reg-password"
                type="password"
                className="form-input"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="reg-confirm">
                Xác nhận mật khẩu
              </label>
              <input
                id="reg-confirm"
                type="password"
                className="form-input"
                autoComplete="new-password"
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
              {isSubmitting ? 'Đang gửi đăng ký...' : 'Tạo tài khoản chờ duyệt'}
            </button>

            <div className="auth-links">
              <Link to="/login">Đã có tài khoản? Quay lại đăng nhập</Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

