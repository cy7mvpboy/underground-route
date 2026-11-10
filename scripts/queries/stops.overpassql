[out:json][timeout:240];
// 한국 안의 철도 정차 위치(선로 위의 노드)와 stop_area relation(역 노드·정차 위치 묶음)
area["ISO3166-1"="KR"][admin_level=2]->.kr;
(
  node(area.kr)[railway=stop];
  node(area.kr)[public_transport=stop_position][train=yes];
  node(area.kr)[public_transport=stop_position][subway=yes];
  node(area.kr)[public_transport=stop_position][light_rail=yes];
  node(area.kr)[public_transport=stop_position][monorail=yes];
);
out body;
rel(area.kr)[public_transport=stop_area];
out body;
