using System.Net;
using System.Net.Mail;
using PackingProof.Infrastructure.Configuration;

namespace PackingProof.Infrastructure.Notifications;

public interface IPasswordResetEmailSender
{
    bool IsConfigured { get; }
    Task SendPasswordResetEmailAsync(string toEmail, string fullName, string resetToken, CancellationToken ct = default);
}

public sealed class SmtpPasswordResetEmailSender : IPasswordResetEmailSender
{
    private readonly PackingProofOptions _options;

    public SmtpPasswordResetEmailSender(PackingProofOptions options)
    {
        _options = options;
    }

    public bool IsConfigured => _options.IsSmtpConfigured;

    public async Task SendPasswordResetEmailAsync(
        string toEmail,
        string fullName,
        string resetToken,
        CancellationToken ct = default)
    {
        if (!_options.IsSmtpConfigured)
        {
            throw new InvalidOperationException("SMTP is not configured.");
        }

        var encodedEmail = Uri.EscapeDataString(toEmail);
        var encodedToken = Uri.EscapeDataString(resetToken);
        var resetUrl = $"{_options.AppPublicOrigin.TrimEnd('/')}/reset-password?email={encodedEmail}&token={encodedToken}";

        using var client = new SmtpClient(_options.SmtpHost!, _options.SmtpPort)
        {
            EnableSsl = _options.SmtpPort is 587 or 465
        };

        if (!string.IsNullOrWhiteSpace(_options.SmtpUser))
        {
            client.Credentials = new NetworkCredential(_options.SmtpUser, _options.SmtpPassword);
        }

        using var message = new MailMessage(_options.SmtpFrom, toEmail)
        {
            Subject = "[PackingProof Web] Đặt lại mật khẩu tài khoản",
            Body =
                $"Xin chào {fullName},\n\n" +
                $"Bạn vừa yêu cầu đặt lại mật khẩu trên hệ thống PackingProof Web.\n" +
                $"Vui lòng mở liên kết dưới đây để đặt mật khẩu mới:\n{resetUrl}\n\n" +
                $"Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.",
            IsBodyHtml = false
        };

        await client.SendMailAsync(message, ct);
    }
}

