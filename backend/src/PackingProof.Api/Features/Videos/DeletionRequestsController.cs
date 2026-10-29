using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Admin;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Features.Videos;

[ApiController]
[Route("api/deletion-requests")]
[Authorize]
public sealed class DeletionRequestsController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IAuditLogger _auditLogger;

    public DeletionRequestsController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        IAuditLogger auditLogger)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _auditLogger = auditLogger;
    }

    [HttpGet]
    public async Task<ActionResult<PaginatedResponse<DeletionRequestListItemDto>>> ListDeletionRequests(
        [FromQuery] DeletionRequestStatus? status = null,
        [FromQuery] Guid? shopId = null,
        [FromQuery] Guid? warehouseId = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);

        if (!ScopeQueryExtensions.TryApplyRecordingPermissionScope(
            _db.Recordings.AsNoTracking(),
            access,
            PermissionCatalog.VideoDeleteApprove,
            out var scopedRecordings))
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.deletion_requests.list",
                EntityType: "DeletionRequest",
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: HttpContext.GetUserEmail(),
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "MISSING_VIDEO_DELETE_APPROVE_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền xem danh sách duyệt yêu cầu xóa video."));
        }

        var scopedRecordingIds = scopedRecordings.Select(r => r.Id);

        IQueryable<DeletionRequest> query = _db.DeletionRequests
            .AsNoTracking()
            .Where(d => scopedRecordingIds.Contains(d.RecordingId));

        if (status.HasValue)
        {
            query = query.Where(d => d.Status == status.Value);
        }

        if (shopId.HasValue)
        {
            query = query.Where(d => d.Recording.ShopId == shopId.Value);
        }

        if (warehouseId.HasValue)
        {
            query = query.Where(d => d.Recording.WarehouseId == warehouseId.Value);
        }

        var normalizedPage = Math.Max(1, page);
        var normalizedPageSize = Math.Clamp(pageSize, 1, 100);

        var totalCount = await query.CountAsync(ct);

        var items = await query
            .OrderBy(d => d.Status == DeletionRequestStatus.Pending ? 0 : 1)
            .ThenByDescending(d => d.CreatedAtUtc)
            .Skip((normalizedPage - 1) * normalizedPageSize)
            .Take(normalizedPageSize)
            .Select(d => new DeletionRequestListItemDto(
                d.Id,
                d.RecordingId,
                d.Recording.TrackingNumber,
                d.Recording.ShopId,
                d.Recording.Shop.Name,
                d.Recording.WarehouseId,
                d.Recording.Warehouse.Name,
                d.Recording.Hold,
                d.Recording.HoldReason,
                d.Recording.IsSoftDeleted,
                d.RequestedByUserId,
                d.RequestedByUser.Email ?? string.Empty,
                d.RequestedByUser.FullName,
                d.Reason,
                d.Status,
                d.ReviewedByUserId,
                d.ReviewedByUser != null ? d.ReviewedByUser.Email : null,
                d.ReviewedByUser != null ? d.ReviewedByUser.FullName : null,
                d.ReviewNote,
                d.CreatedAtUtc,
                d.ReviewedAtUtc))
            .ToListAsync(ct);

        return Ok(new PaginatedResponse<DeletionRequestListItemDto>(
            Items: items,
            TotalCount: totalCount,
            Page: normalizedPage,
            PageSize: normalizedPageSize));
    }

    [HttpPost("{requestId:guid}/approve")]
    public async Task<ActionResult<DeletionRequestListItemDto>> ApproveDeletionRequest(
        Guid requestId,
        [FromBody] ReviewDeletionRequestPayload? payload,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actorEmail = HttpContext.GetUserEmail();

        var deletionRequest = await _db.DeletionRequests
            .Include(d => d.Recording)
                .ThenInclude(r => r.Shop)
            .Include(d => d.Recording)
                .ThenInclude(r => r.Warehouse)
            .Include(d => d.RequestedByUser)
            .FirstOrDefaultAsync(d => d.Id == requestId, ct);

        if (deletionRequest is null)
        {
            return NotFound(new ApiErrorResponse(
                "DELETION_REQUEST_NOT_FOUND",
                "Không tìm thấy yêu cầu xóa video."));
        }

        var recording = deletionRequest.Recording;
        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canApprove = await _scopeAuth.HasPermissionAsync(
            actorId,
            PermissionCatalog.VideoDeleteApprove,
            resourceScope,
            ct);

        if (!canApprove)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.delete_request_approve",
                EntityType: "DeletionRequest",
                EntityId: deletionRequest.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: actorEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "OUT_OF_SCOPE_OR_MISSING_DELETE_APPROVE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền phê duyệt xóa video tại Shop/Kho này."));
        }

        // Always re-check Hold at approval time even if Hold was turned on after the deletion request was created!
        if (recording.Hold)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.delete_approve_blocked_hold",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: actorEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    deletionRequestId = deletionRequest.Id,
                    trackingNumber = recording.TrackingNumber,
                    holdReason = recording.HoldReason
                }), ct);

            return Conflict(new ApiErrorResponse(
                "VIDEO_ON_HOLD",
                "Không thể phê duyệt xóa vì video hiện đang được giữ lại (Hold) để bảo vệ bằng chứng khiếu nại."));
        }

        if (deletionRequest.Status != DeletionRequestStatus.Pending)
        {
            return Conflict(new ApiErrorResponse(
                "DELETION_REQUEST_ALREADY_REVIEWED",
                "Yêu cầu xóa này đã được xử lý trước đó."));
        }

        var now = DateTime.UtcNow;
        var reviewNote = NormalizeReviewNote(payload?.ReviewNote);

        deletionRequest.Status = DeletionRequestStatus.Approved;
        deletionRequest.ReviewedByUserId = actorId;
        deletionRequest.ReviewedAtUtc = now;
        deletionRequest.ReviewNote = reviewNote;

        recording.IsSoftDeleted = true;
        recording.DeletedAtUtc = now;
        recording.UpdatedAtUtc = now;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.soft_deleted",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: actorEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                deletionRequestId = deletionRequest.Id,
                trackingNumber = recording.TrackingNumber,
                requestedByUserId = deletionRequest.RequestedByUserId,
                reason = deletionRequest.Reason,
                reviewNote
            }), ct);

        var reviewer = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == actorId)
            .Select(u => new { Email = u.Email ?? string.Empty, u.FullName })
            .FirstAsync(ct);

        return Ok(MapToListItem(deletionRequest, reviewer.Email, reviewer.FullName));
    }

    [HttpPost("{requestId:guid}/reject")]
    public async Task<ActionResult<DeletionRequestListItemDto>> RejectDeletionRequest(
        Guid requestId,
        [FromBody] ReviewDeletionRequestPayload? payload,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actorEmail = HttpContext.GetUserEmail();

        var deletionRequest = await _db.DeletionRequests
            .Include(d => d.Recording)
                .ThenInclude(r => r.Shop)
            .Include(d => d.Recording)
                .ThenInclude(r => r.Warehouse)
            .Include(d => d.RequestedByUser)
            .FirstOrDefaultAsync(d => d.Id == requestId, ct);

        if (deletionRequest is null)
        {
            return NotFound(new ApiErrorResponse(
                "DELETION_REQUEST_NOT_FOUND",
                "Không tìm thấy yêu cầu xóa video."));
        }

        var recording = deletionRequest.Recording;
        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canApprove = await _scopeAuth.HasPermissionAsync(
            actorId,
            PermissionCatalog.VideoDeleteApprove,
            resourceScope,
            ct);

        if (!canApprove)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.delete_request_reject",
                EntityType: "DeletionRequest",
                EntityId: deletionRequest.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: actorEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "OUT_OF_SCOPE_OR_MISSING_DELETE_APPROVE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền từ chối yêu cầu xóa video tại Shop/Kho này."));
        }

        if (deletionRequest.Status != DeletionRequestStatus.Pending)
        {
            return Conflict(new ApiErrorResponse(
                "DELETION_REQUEST_ALREADY_REVIEWED",
                "Yêu cầu xóa này đã được xử lý trước đó."));
        }

        var now = DateTime.UtcNow;
        var reviewNote = NormalizeReviewNote(payload?.ReviewNote);

        deletionRequest.Status = DeletionRequestStatus.Rejected;
        deletionRequest.ReviewedByUserId = actorId;
        deletionRequest.ReviewedAtUtc = now;
        deletionRequest.ReviewNote = reviewNote;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.delete_request_rejected",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: actorEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                deletionRequestId = deletionRequest.Id,
                trackingNumber = recording.TrackingNumber,
                requestedByUserId = deletionRequest.RequestedByUserId,
                reviewNote
            }), ct);

        var reviewer = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == actorId)
            .Select(u => new { Email = u.Email ?? string.Empty, u.FullName })
            .FirstAsync(ct);

        return Ok(MapToListItem(deletionRequest, reviewer.Email, reviewer.FullName));
    }

    private static string? NormalizeReviewNote(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var trimmed = raw.Trim();
        return trimmed.Length > 1000 ? trimmed[..1000] : trimmed;
    }

    private static DeletionRequestListItemDto MapToListItem(
        DeletionRequest d,
        string reviewerEmail,
        string reviewerFullName) =>
        new(
            Id: d.Id,
            RecordingId: d.RecordingId,
            TrackingNumber: d.Recording.TrackingNumber,
            ShopId: d.Recording.ShopId,
            ShopName: d.Recording.Shop.Name,
            WarehouseId: d.Recording.WarehouseId,
            WarehouseName: d.Recording.Warehouse.Name,
            RecordingHold: d.Recording.Hold,
            RecordingHoldReason: d.Recording.HoldReason,
            RecordingIsSoftDeleted: d.Recording.IsSoftDeleted,
            RequestedByUserId: d.RequestedByUserId,
            RequestedByEmail: d.RequestedByUser.Email ?? string.Empty,
            RequestedByFullName: d.RequestedByUser.FullName,
            Reason: d.Reason,
            Status: d.Status,
            ReviewedByUserId: d.ReviewedByUserId,
            ReviewedByEmail: reviewerEmail,
            ReviewedByFullName: reviewerFullName,
            ReviewNote: d.ReviewNote,
            CreatedAtUtc: d.CreatedAtUtc,
            ReviewedAtUtc: d.ReviewedAtUtc);
}
