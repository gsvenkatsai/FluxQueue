// src/components/ThroughputChart.tsx
interface DataPoint {
  minute: string;
  count: number;
}

interface Props {
  data: DataPoint[];
}

export default function ThroughputChart({ data }: Props) {
  if (!data || data.length === 0)
    return <p className="text-gray-500 text-sm">No throughput data yet — submit some jobs.</p>;

  const width = 700;
  const height = 180;
  const padX = 40;
  const padY = 20;

  const maxCount = Math.max(...data.map((d) => d.count));

  const points = data.map((d, i) => {
    const x =
      data.length === 1
        ? padX + (width - padX * 2) / 2
        : padX + (i / (data.length - 1)) * (width - padX * 2);
    const y =
      maxCount === 0
        ? height - padY
        : padY + (1 - d.count / maxCount) * (height - padY * 2);
    return `${x},${y}`;
  });

  const pointsStr = points.join(" ");

  return (
    <div className="w-full overflow-x-auto">
      <svg width={width} height={height} className="rounded-lg" style={{ background: "#111827" }}>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((t) => {
          const y = padY + t * (height - padY * 2);
          return (
            <line
              key={t}
              x1={padX}
              y1={y}
              x2={width - padX}
              y2={y}
              stroke="#374151"
              strokeDasharray="4,4"
            />
          );
        })}
        {/* Y-axis */}
        <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="#4b5563" />
        {/* X-axis */}
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="#4b5563" />
        {/* Area fill */}
        <polyline
          fill="none"
          stroke="#06b6d4"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={pointsStr}
        />
        {/* Dots */}
        {data.map((d, i) => {
          const x =
            data.length === 1
              ? padX + (width - padX * 2) / 2
              : padX + (i / (data.length - 1)) * (width - padX * 2);
          const y =
            maxCount === 0
              ? height - padY
              : padY + (1 - d.count / maxCount) * (height - padY * 2);
          return <circle key={i} cx={x} cy={y} r={3} fill="#06b6d4" />;
        })}
        {/* Y labels */}
        <text x={0} y={padY + 4} fill="#6b7280" fontSize={10}>{maxCount}</text>
        <text x={0} y={height - padY + 4} fill="#6b7280" fontSize={10}>0</text>
        {/* X labels */}
        <text x={padX} y={height + 14} fill="#6b7280" fontSize={10}>
          {new Date(data[0].minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </text>
        {data.length > 1 && (
          <text x={width - padX - 30} y={height + 14} fill="#6b7280" fontSize={10}>
            {new Date(data[data.length - 1].minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </text>
        )}
      </svg>
    </div>
  );
}
