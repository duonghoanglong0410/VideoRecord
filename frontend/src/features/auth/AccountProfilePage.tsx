import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2
} from 'lucide-react';
import { apiRequest, setCsrfToken } from '../../app/apiClient';
import { useAuth } from '../../app/authStore';
import { PageHeader } from '../../components/ui/PageHeader';

export function AccountProfilePage() {
  const { user, refreshMe } = useAuth();

  // Change password state
  const [currentPassword, setCurrentPassword] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showCurrentPwd, setShowCurrentPwd] = useState<boolean>(false);
  const [showNewPwd, setShowNewPwd] = useState<boolean>(false);
  const [isChangingPwd, setIsChangingPwd] = useState<boolean>(false);
  const [pwdSuccess, setPwdSuccess] = useState<string | null>(null);
  const [pwdError, setPwdError] = useState<string | null>(null);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwdError(null);
    setPwdSuccess(null);

    if (newPassword !== confirmPassword) {
      setPwdError('Mật khẩu mới và xác nhận mật khẩu không khớp.');
      return;
    }

    setIsChangingPwd(true);
    try {
      const res = await apiRequest<{ message: string; csrfToken?: string }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: {
            currentPassword,
            newPassword,
            confirmPassword
          }
        }
      );
      if (res.csrfToken) {
        setCsrfToken(res.csrfToken);
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refreshMe();
      setPwdSuccess(res.message);
    } catch (err) {
      setPwdError(
        err instanceof Error ? err.message : 'Không thể đổi mật khẩu.'
      );
    } finally {
      setIsChangingPwd(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <PageHeader
          title="Tài khoản của tôi"
          subtitle={`Đổi mật khẩu đăng nhập cho tài khoản ${user.email}.`}
        />

        {user.forcePasswordReset && (
          <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-sm text-amber-950"
            role="status"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
              aria-hidden="true"
            />
            <span>
              <strong>Khuyến nghị bảo mật:</strong> Tài khoản của bạn đang dùng mật khẩu do quản trị viên cấp. Vui lòng đổi sang mật khẩu cá nhân của riêng bạn bên dưới.
            </span>
          </div>
        )}
      </div>

      {/* Change Password Card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="m-0 text-base font-bold text-slate-900">
              Đổi mật khẩu đăng nhập
            </h2>
            <p className="mt-0.5 mb-0 text-xs text-slate-500">
              Sau khi đổi mật khẩu, bạn vẫn giữ nguyên phiên làm việc trên máy này.
            </p>
          </div>
        </div>

        {pwdSuccess && (
          <div
            className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-950"
            role="status"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            <span>{pwdSuccess}</span>
          </div>
        )}

        {pwdError && (
          <div
            className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-900"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            <span>{pwdError}</span>
          </div>
        )}

        <form
          className="space-y-4"
          onSubmit={(e) => void handleChangePassword(e)}
        >
          <div>
            <label
              htmlFor="account-current-password"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
              Mật khẩu hiện tại <span className="text-red-600">*</span>
            </label>
            <div className="relative">
              <input
                id="account-current-password"
                type={showCurrentPwd ? 'text' : 'password'}
                autoComplete="current-password"
                className="form-input pr-12"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Nhập mật khẩu đang dùng"
                required
              />
              <button
                type="button"
                onClick={() => setShowCurrentPwd((v) => !v)}
                className="absolute top-1/2 right-1 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label={showCurrentPwd ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showCurrentPwd ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="account-new-password"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
              Mật khẩu mới <span className="text-red-600">*</span>
            </label>
            <div className="relative">
              <input
                id="account-new-password"
                type={showNewPwd ? 'text' : 'password'}
                autoComplete="new-password"
                className="form-input pr-12"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Tối thiểu 8 ký tự, có chữ hoa, số & ký tự đặc biệt"
                required
              />
              <button
                type="button"
                onClick={() => setShowNewPwd((v) => !v)}
                className="absolute top-1/2 right-1 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label={showNewPwd ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showNewPwd ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="account-confirm-password"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
              Nhập lại mật khẩu mới <span className="text-red-600">*</span>
            </label>
            <input
              id="account-confirm-password"
              type={showNewPwd ? 'text' : 'password'}
              autoComplete="new-password"
              className="form-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Nhập khớp với mật khẩu mới ở trên"
              required
            />
          </div>

          <div className="flex justify-end border-t border-slate-100 pt-3">
            <button
              type="submit"
              disabled={isChangingPwd}
              className="btn btn-primary inline-flex w-full cursor-pointer items-center justify-center gap-1.5 sm:w-auto"
            >
              {isChangingPwd ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden="true" />
              )}
              <span>
                {isChangingPwd ? 'Đang đổi mật khẩu...' : 'Cập nhật mật khẩu mới'}
              </span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}



