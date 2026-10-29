using PackingProof.Core.Enums;

namespace PackingProof.Core.Abstractions;

public sealed record GrantProposal(
    Guid RoleId,
    ScopeType ScopeType,
    Guid? ShopId = null,
    Guid? WarehouseId = null);

public sealed record GrantValidationResult(
    bool IsAllowed,
    string? ErrorCode = null,
    string? UserMessage = null)
{
    public static GrantValidationResult Allowed() => new(true);

    public static GrantValidationResult Denied(string errorCode, string userMessage) =>
        new(false, errorCode, userMessage);
}

public interface IGrantCeilingValidator
{
    Task<GrantValidationResult> ValidateRoleAssignmentAsync(
        Guid actorUserId,
        Guid targetUserId,
        Guid roleId,
        ScopeType scopeType,
        Guid? shopId,
        Guid? warehouseId,
        CancellationToken ct = default);

    Task<GrantValidationResult> ValidateGrantsAssignmentAsync(
        Guid actorUserId,
        Guid targetUserId,
        IReadOnlyList<GrantProposal> proposedGrants,
        CancellationToken ct = default);

    Task<GrantValidationResult> ValidateUserManagementActionAsync(
        Guid actorUserId,
        Guid targetUserId,
        string actionType,
        CancellationToken ct = default);

    Task<GrantValidationResult> ValidateCustomRoleAsync(
        Guid actorUserId,
        Guid? existingRoleId,
        IReadOnlyCollection<string> permissionCodes,
        CancellationToken ct = default);
}

