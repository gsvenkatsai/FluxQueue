// src/components/ThroughputChart.tsx
interface DataPoint {
  minute: string;
  count: number;
}

interface Props {
  data: DataPoint[];
}

export default function ThroughputChart({ data }: Props) {
  if (!data || data.length === 0) return <p>No throughput data</p>;

  const width = 600;
  const height = 200;
  const padX = 40;
  const padY = 20;

  const maxCount = Math.max(...data.map((d) => d.count));

  const points = data.map((d, i) => {
    const x = padX + (i / (data.length - 1)) * (width - padX * 2);
    const y = padY + (1 - d.count / maxCount) * (height - padY * 2);
    return `${x},${y}`;
  });

  const pointsStr = points.join(" ");

  return (
    <div>
      <h3>Job Throughput (last 60 min)</h3>
      <svg width={width} height={height} style={{ background: "#1a1a2e" }}>
        {/* Y-axis */}
        <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="#555" />
        {/* X-axis */}
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          stroke="#555"
        />
        {/* Line */}
        <polyline
          fill="none"
          stroke="#00bcd4"
          strokeWidth={2}
          points={pointsStr}
        />
        {/* Y max label */}
        <text x={0} y={padY + 4} fill="#aaa" fontSize={11}>
          {maxCount}
        </text>
        {/* Y min label */}
        <text x={0} y={height - padY + 4} fill="#aaa" fontSize={11}>
          0
        </text>
        {/* X labels — first and last */}
        <text x={padX} y={height} fill="#aaa" fontSize={10}>
          {new Date(data[0].minute).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </text>
        <text x={width - padX - 30} y={height} fill="#aaa" fontSize={10}>
          {new Date(data[data.length - 1].minute).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </text>
      </svg>
    </div>
  );
}
