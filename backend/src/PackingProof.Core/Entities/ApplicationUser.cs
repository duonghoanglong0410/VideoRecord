using Microsoft.AspNetCore.Identity;
using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class ApplicationUser : IdentityUser<Guid>
{
    public string FullName { get; set; } = string.Empty;
    public ApprovalStatus ApprovalStatus { get; set; } = ApprovalStatus.PendingApproval;
    public Guid? DefaultShopId { get; set; }
    public Shop? DefaultShop { get; set; }
    public Guid? DefaultWarehouseId { get; set; }
    public Warehouse? DefaultWarehouse { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime? ApprovedAtUtc { get; set; }
    public Guid? ApprovedByUserId { get; set; }
    public DateTime? LockedAtUtc { get; set; }
    public Guid? LockedByUserId { get; set; }
    public bool ForcePasswordReset { get; set; }

    public ICollection<UserScopeGrant> ScopeGrants { get; set; } = new List<UserScopeGrant>();
}

