[out:json][timeout:240];
// 한국 안의 철도 노선 relation(route=subway|train|light_rail|monorail|railway): 태그와 멤버 목록
area["ISO3166-1"="KR"][admin_level=2]->.kr;
rel(area.kr)[type=route][route~"^(subway|train|light_rail|monorail|railway)$"];
out body;
