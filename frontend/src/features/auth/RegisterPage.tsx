import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, PackageCheck, UserPlus } from 'lucide-react';
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
  const [showPassword, setShowPassword] = useState(false);
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
      setErrorMessage('Mật khẩu nhập lại chưa khớp.');
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
            <span className="brand-badge">
              <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
              PackingProof Web
            </span>
            <h1 className="brand-title">Đăng ký tài khoản nhân viên</h1>
            <p className="brand-subtitle">
              Điền thông tin bên dưới, sau đó báo Quản lý Shop kích hoạt tài khoản cho bạn.
            </p>
          </div>

          {errorMessage && (
            <div className="alert alert-error" role="alert">
              <div>{errorMessage}</div>
              {errorDetails.length > 1 && (
                <ul className="mt-2 mb-0 pl-5 text-xs">
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
                Họ và tên
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
                placeholder="Ví dụ: Nguyễn Văn An"
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
              <div className="relative">
                <input
                  id="reg-password"
                  type={showPassword ? 'text' : 'password'}
                  className="form-input pr-12"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Tạo mật khẩu an toàn"
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
              <label className="form-label" htmlFor="reg-confirm">
                Nhập lại mật khẩu
              </label>
              <input
                id="reg-confirm"
                type={showPassword ? 'text' : 'password'}
                className="form-input"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Nhập lại đúng mật khẩu trên"
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-full"
              disabled={isSubmitting}
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
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
