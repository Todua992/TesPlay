/**
 * The sign-in scene: layered hills at dusk under a low sun, with one red line
 * of tail lights along a coast road. Flat layers in the style of TesPlay's
 * demo artwork; the bottom fades into the page so the content below continues.
 */
export default function AuthScene() {
  return (
    <svg className="auth-scene" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="auth-scene-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b0c0f" />
          <stop offset=".55" stopColor="#12161b" />
          <stop offset="1" stopColor="#202a31" />
        </linearGradient>
        <linearGradient id="auth-scene-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset=".6" stopColor="#0e0e10" stopOpacity="0" />
          <stop offset="1" stopColor="#0e0e10" />
        </linearGradient>
      </defs>
      <rect width="1600" height="900" fill="url(#auth-scene-sky)" />
      <circle className="auth-scene-sun" cx="867" cy="640" r="84" fill="#a88b6c" />
      <path d="M0 640C180 596 330 600 500 628S800 676 980 650 1300 590 1600 612V900H0Z" fill="#283640" />
      <path d="M0 716C230 668 420 672 620 708S1000 772 1220 742 1480 690 1600 704V900H0Z" fill="#1b252c" />
      <path className="auth-scene-road" d="M-20 742C200 706 380 708 600 736S960 786 1180 762 1460 718 1620 726" fill="none" stroke="#e82127" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M0 800C300 760 560 770 860 806S1340 844 1600 802V900H0Z" fill="#111619" />
      <rect width="1600" height="900" fill="url(#auth-scene-fade)" />
    </svg>
  );
}
