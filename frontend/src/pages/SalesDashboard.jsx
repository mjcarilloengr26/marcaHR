import { useEffect, useState } from "react";
import { api } from "../api/client";
import Funnel from "../components/Funnel";

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function SalesDashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/sales/stats").then(setStats).catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!stats) return <div className="page-loading">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sales Dashboard</h1>
          <p className="subtitle">Pipeline and order fulfillment at a glance</p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.pipelineValue)}</div>
          <div className="stat-label">Open pipeline value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.wonValue)}</div>
          <div className="stat-label">Won value</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.kpis.openDeals}</div>
          <div className="stat-label">Open deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{money(stats.kpis.ordersRevenue)}</div>
          <div className="stat-label">Orders revenue</div>
        </div>
      </div>

      <div className="grid grid-2">
        <Funnel
          title="Sales pipeline"
          subtitle="Deals by stage reached"
          stages={stats.dealFunnel.stages}
          branchLabel="Lost"
          branchCount={stats.dealFunnel.lost}
          branchUnit="deal"
        />
        <Funnel
          title="Order fulfillment"
          subtitle="Orders by status reached"
          stages={stats.orderFunnel.stages}
          branchLabel="Cancelled"
          branchCount={stats.orderFunnel.cancelled}
          branchUnit="order"
        />
      </div>
    </div>
  );
}
