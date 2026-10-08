// M1 시드 장부 — 결제(M2) 전까지 발사체를 채우는 하우스 광고.
//   🔴 실존 브랜드 로고 금지(상표권 — PRD Risks). 전부 isHouse=true 이고, 전광판의 "판매 칸"에는
//   세지 않는다(실제로 팔린 게 아닌데 팔린 것처럼 보이면 기만 — PRD 핵심 규칙).
//   로고는 동일 출처 경로여야 사망 카드 캔버스가 오염되지 않는다(index-html.test.js가 검사).

const SEED_LEDGER = [
  { id: 'jugan-lab', name: '주간실험실', slots: 40, logo: 'assets/logos/jugan-lab.svg', isHouse: true },
  { id: 'ad-wanted', name: '이 자리 광고 구함', slots: 40, logo: 'assets/logos/ad-wanted.svg', isHouse: true },
  { id: 'sample-a', name: '샘플 광고 A', slots: 15, logo: 'assets/logos/sample-a.svg', isHouse: true },
  { id: 'sample-b', name: '샘플 광고 B', slots: 5, logo: 'assets/logos/sample-b.svg', isHouse: true },
];

if (typeof module !== 'undefined') {
  module.exports = { SEED_LEDGER };
}
