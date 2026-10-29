using System.Text.Json;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Auditing;
using Xunit;

namespace PackingProof.UnitTests.Auditing;

public sealed class AuditScrubberTests
{
    [Fact]
    public async Task AuditLogger_RemovesAllSensitiveKeysRecursively_WhilePreservingBusinessFields()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var logger = new AuditLogger(db);

        var metadata = new
        {
            targetEmail = "operator@example.local",
            shopCode = "ShopA",
            password = "SuperSecretPassword!123",
            confirmPassword = "SuperSecretPassword!123",
            resetToken = "CfDJ8_SENSITIVE_RESET_TOKEN_999",
            csrfToken = "ANTIFORGERY_TOKEN_VALUE",
            cookie = "PackingProof.Auth=ENCRYPTED_COOKIE_PAYLOAD",
            secret = "NAS_OR_TOTP_SECRET_VALUE",
            authorization = "Bearer eyJhbGciOiJIUzI1NiJ9.SENSITIVE",
            qrRaw = "https://carrier-internal.example/order?phone=0909123456&addr=Private",
            recoveryCode = "ABCD-EFGH-1234",
            authenticatorKey = "JBSWY3DPEHPK3PXP",
            nested = new
            {
                actionReason = "Đặt lại mật khẩu có kiểm soát",
                innerToken = "NESTED_SECRET_TOKEN",
                totpUri = "otpauth://totp/PackingProof:admin@example.local?secret=JBSWY3DPEHPK3PXP",
                items = new object[]
                {
                    new { label = "safe-item", clientSecret = "ARRAY_SECRET_123" }
                }
            }
        };

        await logger.AppendAsync(new AuditEntryRequest(
            Action: "test.scrubbing",
            EntityType: "User",
            EntityId: "user-01",
            Outcome: AuditOutcome.Success,
            Metadata: metadata));

        var saved = Assert.Single(db.AuditEvents);
        var json = saved.MetadataJson;

        // Verify none of the sensitive values leaked anywhere into MetadataJson
        Assert.DoesNotContain("SuperSecretPassword!123", json);
        Assert.DoesNotContain("CfDJ8_SENSITIVE_RESET_TOKEN_999", json);
        Assert.DoesNotContain("ANTIFORGERY_TOKEN_VALUE", json);
        Assert.DoesNotContain("ENCRYPTED_COOKIE_PAYLOAD", json);
        Assert.DoesNotContain("NAS_OR_TOTP_SECRET_VALUE", json);
        Assert.DoesNotContain("eyJhbGciOiJIUzI1NiJ9", json);
        Assert.DoesNotContain("0909123456", json);
        Assert.DoesNotContain("ABCD-EFGH-1234", json);
        Assert.DoesNotContain("JBSWY3DPEHPK3PXP", json);
        Assert.DoesNotContain("NESTED_SECRET_TOKEN", json);
        Assert.DoesNotContain("ARRAY_SECRET_123", json);

        // Verify safe business fields remain intact
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("operator@example.local", doc.RootElement.GetProperty("targetEmail").GetString());
        Assert.Equal("ShopA", doc.RootElement.GetProperty("shopCode").GetString());
        var nested = doc.RootElement.GetProperty("nested");
        Assert.Equal("Đặt lại mật khẩu có kiểm soát", nested.GetProperty("actionReason").GetString());
        Assert.Equal("[REDACTED]", nested.GetProperty("totpUri").GetString());
        Assert.False(doc.RootElement.TryGetProperty("password", out _));
        Assert.False(doc.RootElement.TryGetProperty("resetToken", out _));
        Assert.False(doc.RootElement.TryGetProperty("cookie", out _));
        Assert.False(doc.RootElement.TryGetProperty("qrRaw", out _));
    }
}

