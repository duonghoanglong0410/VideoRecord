using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;

namespace PackingProof.Api.Features.Dashboard;

public sealed record DashboardRecentVideoDto(
    Guid Id,
    string TrackingNumber,
    string ShopName,
    string WarehouseName,
    string OwnerFullName,
    RecordingSource Source,
    CaptureStatus CaptureStatus,
    StorageStatus StorageStatus,
    StorageMode StorageMode,
    bool Hold,
    double? DurationSeconds,
    DateTime CreatedAtUtc,
    DateTime? StoredAtUtc);

public sealed record DashboardSummaryDto(
    StorageMode ActiveStorageMode,
    int TodayRecordingsCount,
    int TotalStoredCount,
    int AwaitingOrValidatingCount,
    int InterruptedOrFailedCount,
    int OnHoldCount,
    int? PendingDeletionRequestsCount,
    int? PendingUserApprovalsCount,
    bool HasVideoViewScope,
    bool CanCreateRecording,
    IReadOnlyList<DashboardRecentVideoDto> RecentVideos,
    DateTime GeneratedAtUtc);

[ApiController]
[Route("api/dashboard")]
[Authorize]
public sealed class DashboardController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly PackingProofOptions _options;

    public DashboardController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        PackingProofOptions options)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _options = options;
    }

    [HttpGet("summary")]
    public async Task<ActionResult<DashboardSummaryDto>> GetSummary(CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(userId, ct);

        if (!access.IsActive)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Tài khoản hiện không ở trạng thái hoạt động."));
        }

        var now = DateTime.UtcNow;
        var (todayStartUtc, todayEndExclusiveUtc) = StoragePathBuilder.GetHoChiMinhTodayUtcRange(now);

        var baseRecordings = _db.Recordings
            .AsNoTracking()
            .Where(r =>
                !r.IsSoftDeleted &&
                (r.CaptureStatus == CaptureStatus.Captured ||
                 r.CaptureStatus == CaptureStatus.Interrupted));

        var hasVideoViewScope = ScopeQueryExtensions.TryApplyRecordingPermissionScope(
            baseRecordings,
            access,
            PermissionCatalog.VideoView,
            out var scopedRecordings);

        if (!hasVideoViewScope)
        {
            // Fall back to user's own recordings if they only hold recording.create without video.view
            if (access.AllPermissions.Contains(PermissionCatalog.RecordingCreate))
            {
                scopedRecordings = baseRecordings.Where(r => r.OwnerUserId == userId);
            }
            else
            {
                scopedRecordings = baseRecordings.Where(_ => false);
            }
        }

        var todayRecordingsCount = await scopedRecordings
            .CountAsync(r =>
                r.CaptureStatus != CaptureStatus.Cancelled &&
                r.CreatedAtUtc >= todayStartUtc &&
                r.CreatedAtUtc < todayEndExclusiveUtc, ct);

        var totalStoredCount = await scopedRecordings
            .CountAsync(r => r.StorageStatus == StorageStatus.Stored, ct);

        var awaitingOrValidatingCount = await scopedRecordings
            .CountAsync(r =>
                r.CaptureStatus != CaptureStatus.Cancelled &&
                (r.StorageStatus == StorageStatus.AwaitingUpload ||
                 r.StorageStatus == StorageStatus.Uploading ||
                 r.StorageStatus == StorageStatus.Validating ||
                 r.StorageStatus == StorageStatus.WaitingForStorage ||
                 r.StorageStatus == StorageStatus.CopyingToStorage), ct);

        var interruptedOrFailedCount = await scopedRecordings
            .CountAsync(r =>
                r.CaptureStatus == CaptureStatus.Interrupted ||
                r.StorageStatus == StorageStatus.Failed, ct);

        var onHoldCount = await scopedRecordings
            .CountAsync(r => r.Hold, ct);

        int? pendingDeletionRequestsCount = null;
        if (ScopeQueryExtensions.TryApplyRecordingPermissionScope(
            baseRecordings,
            access,
            PermissionCatalog.VideoDeleteApprove,
            out var deletionScopedRecordings))
        {
            var scopedIds = deletionScopedRecordings.Select(r => r.Id);
            pendingDeletionRequestsCount = await _db.DeletionRequests
                .AsNoTracking()
                .CountAsync(d =>
                    d.Status == DeletionRequestStatus.Pending &&
                    scopedIds.Contains(d.RecordingId), ct);
        }

        int? pendingUserApprovalsCount = null;
        if (access.AllPermissions.Contains(PermissionCatalog.UserManage))
        {
            if (access.IsSuperAdmin)
            {
                pendingUserApprovalsCount = await _db.Users
                    .AsNoTracking()
                    .CountAsync(u => u.ApprovalStatus == ApprovalStatus.PendingApproval, ct);
            }
            else
            {
                var managedShopIds = access.Grants
                    .Where(g =>
                        g.ScopeType == ScopeType.Shop &&
                        g.ShopId.HasValue &&
                        g.Permissions.Contains(PermissionCatalog.UserManage, StringComparer.Ordinal))
                    .Select(g => g.ShopId!.Value)
                    .Distinct()
                    .ToList();

                if (managedShopIds.Count > 0)
                {
                    pendingUserApprovalsCount = await _db.Users
                        .AsNoTracking()
                        .CountAsync(u =>
                            u.ApprovalStatus == ApprovalStatus.PendingApproval &&
                            !u.ScopeGrants.Any(g => g.Role.Name == SystemRoles.SuperAdmin) &&
                            (!u.DefaultShopId.HasValue || managedShopIds.Contains(u.DefaultShopId.Value)), ct);
                }
            }
        }

        var fallbackMode = _options.StorageMode;
        IReadOnlyList<DashboardRecentVideoDto> recentVideos = [];
        if (hasVideoViewScope)
        {
            recentVideos = await scopedRecordings
                .OrderByDescending(r => r.CreatedAtUtc)
                .Take(6)
                .Select(r => new DashboardRecentVideoDto(
                    r.Id,
                    r.TrackingNumber,
                    r.Shop.Name,
                    r.Warehouse.Name,
                    r.OwnerUser.FullName,
                    r.Source,
                    r.CaptureStatus,
                    r.StorageStatus,
                    r.VideoAssets
                        .Where(a => a.Kind == AssetKind.Original)
                        .Select(a => (StorageMode?)a.StorageProfile.Mode)
                        .FirstOrDefault() ?? fallbackMode,
                    r.Hold,
                    r.DurationSeconds,
                    r.CreatedAtUtc,
                    r.StoredAtUtc))
                .ToListAsync(ct);
        }

        return Ok(new DashboardSummaryDto(
            ActiveStorageMode: _options.StorageMode,
            TodayRecordingsCount: todayRecordingsCount,
            TotalStoredCount: totalStoredCount,
            AwaitingOrValidatingCount: awaitingOrValidatingCount,
            InterruptedOrFailedCount: interruptedOrFailedCount,
            OnHoldCount: onHoldCount,
            PendingDeletionRequestsCount: pendingDeletionRequestsCount,
            PendingUserApprovalsCount: pendingUserApprovalsCount,
            HasVideoViewScope: hasVideoViewScope,
            CanCreateRecording: access.AllPermissions.Contains(PermissionCatalog.RecordingCreate),
            RecentVideos: recentVideos,
            GeneratedAtUtc: now));
    }
}
