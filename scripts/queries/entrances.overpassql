[out:json][timeout:240];
// 한국 안의 지하철·철도역 출입구 노드(지상에서 역으로 들어가는 지점)
area["ISO3166-1"="KR"][admin_level=2]->.kr;
(
  node(area.kr)[railway=subway_entrance];
  node(area.kr)[railway=train_station_entrance];
);
out body;
