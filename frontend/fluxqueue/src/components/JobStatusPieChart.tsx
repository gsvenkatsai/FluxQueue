// src/components/JobStatusPieChart.tsx
const COLORS = {
  PENDING: "#f59e0b",
  RUNNING: "#3b82f6",
  COMPLETED: "#22c55e",
  FAILED: "#ef4444",
  DEAD: "#6b7280",
};

interface Props {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
}

export default function JobStatusPieChart(props: Props) {
  const chartData = [
    { name: "PENDING", value: props.pending_count },
    { name: "RUNNING", value: props.running_count },
    { name: "COMPLETED", value: props.completed_count },
    { name: "FAILED", value: props.failed_count },
    { name: "DEAD", value: props.dead_count },
  ].filter((d) => d.value > 0);

  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
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
    </div>
  );
}
