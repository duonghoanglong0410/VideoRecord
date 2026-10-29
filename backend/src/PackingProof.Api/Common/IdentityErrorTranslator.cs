using Microsoft.AspNetCore.Identity;

namespace PackingProof.Api.Common;

public static class IdentityErrorTranslator
{
    public static IReadOnlyList<string> ToVietnamese(IEnumerable<IdentityError> errors)
    {
        return errors.Select(TranslateSingle).Distinct().ToList();
    }

    private static string TranslateSingle(IdentityError error) =>
        error.Code switch
        {
            "DuplicateEmail" or "DuplicateUserName" => "Địa chỉ email này đã được đăng ký trong hệ thống.",
            "InvalidEmail" => "Địa chỉ email không đúng định dạng.",
            "InvalidUserName" => "Tên đăng nhập không hợp lệ.",
            "PasswordTooShort" => "Mật khẩu phải có ít nhất 8 ký tự.",
            "PasswordRequiresDigit" => "Mật khẩu phải chứa ít nhất một chữ số (0–9).",
            "PasswordRequiresLower" => "Mật khẩu phải chứa ít nhất một chữ cái viết thường (a–z).",
            "PasswordRequiresUpper" => "Mật khẩu phải chứa ít nhất một chữ cái viết hoa (A–Z).",
            "PasswordRequiresNonAlphanumeric" => "Mật khẩu phải chứa ít nhất một ký tự đặc biệt.",
            "InvalidToken" => "Mã đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.",
            "PasswordMismatch" => "Mật khẩu hiện tại không chính xác.",
            "DuplicateRoleName" => "Tên vai trò này đã tồn tại.",
            "InvalidRoleName" => "Tên vai trò không hợp lệ.",
            _ => "Dữ liệu tài khoản không hợp lệ. Vui lòng kiểm tra lại."
        };
}
