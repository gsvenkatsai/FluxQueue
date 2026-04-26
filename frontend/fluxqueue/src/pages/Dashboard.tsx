import { useEffect, useState } from "react";

const COLORS = {
  PENDING: "#f59e0b",
  RUNNING: "#3b82f6",
  COMPLETED: "#22c55e",
  FAILED: "#ef4444",
  DEAD: "#6b7280",
};

interface Stats {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
  workers: Worker[];
  failure_rate: number;
}
interface Worker {
  hostname: string;
  is_online: boolean;
  active_jobs: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  // 1. Fetch initial stats from /api/stats/ on mount
  useEffect(() => {
    fetch("http://localhost:8000/api/stats/")
      .then((r) => r.json())
      .then((data) => setStats(data));
  }, []);

  // 2. WebSocket — connect to ws/stats/, on message update stats
  useEffect(() => {
    let ws: WebSocket;

    const connect = () => {
      ws = new WebSocket("ws://localhost:8000/ws/stats/");
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setStats((prev) => ({ ...prev, ...data }));
      };
      ws.onclose = () => setTimeout(connect, 3000);
    };

    connect();
    return () => ws.close();
  }, []);

  // 3. Transform stats into recharts data format
  const chartData = stats
    ? [
        { name: "PENDING", value: stats.pending_count },
        { name: "RUNNING", value: stats.running_count },
        { name: "COMPLETED", value: stats.completed_count },
        { name: "FAILED", value: stats.failed_count },
        { name: "DEAD", value: stats.dead_count },
      ].filter((d) => d.value > 0)
    : [];
  console.log("stats:", stats);
  console.log("chartData:", chartData);
  // 4. Render PieChart
  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Dashboard</h1>
      {stats ? (
        <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
          <svg width={300} height={300} viewBox="0 0 300 300">
            {(() => {
              let angle = -90;
              return chartData.map((d) => {
                const slice = (d.value / total) * 360;
                const start = (angle * Math.PI) / 180;
                const end = ((angle + slice) * Math.PI) / 180;
                const x1 = 150 + 120 * Math.cos(start);
                const y1 = 150 + 120 * Math.sin(start);
                const x2 = 150 + 120 * Math.cos(end);
                const y2 = 150 + 120 * Math.sin(end);
                const large = slice > 180 ? 1 : 0;
                const path = `M150,150 L${x1},${y1} A120,120 0 ${large},1 ${x2},${y2} Z`;
                angle += slice;
                return (
                  <path
                    key={d.name}
                    d={path}
                    fill={COLORS[d.name as keyof typeof COLORS]}
                  />
                );
              });
            })()}
          </svg>
          <div>
            {chartData.map((d) => (
              <div
                key={d.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "8px",
                }}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    background: COLORS[d.name as keyof typeof COLORS],
                  }}
                />
                <span>
                  {d.name}: {d.value}
                </span>
              </div>
            ))}
          </div>
          Failure Rate: {stats.failure_rate.toFixed(1)}%
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th>Active Jobs</th>
              </tr>
            </thead>
            <tbody>
              {stats.workers?.map((w) => (
                <tr key={w.hostname}>
                  <td>{w.hostname}</td>
                  <td>{w.is_online ? "🟢 Online" : "🔴 Offline"}</td>
                  <td>{w.active_jobs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
}
