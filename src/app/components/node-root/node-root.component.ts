import { Component, OnInit, ChangeDetectionStrategy, Input, Output, EventEmitter } from '@angular/core';
import { SelectedKeyInfoHost } from '../../models/redis';

@Component({
  selector: 'app-node-root',
  templateUrl: './node-root.component.html',
  styleUrls: ['./node-root.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodeRootComponent implements OnInit {
  @Input() selectedTabIndex: number;
  @Input() redisId: string;
  @Output() keyTabChanged = new EventEmitter();
  @Output() closeKeyInfo = new EventEmitter();
  keyInfoHost: SelectedKeyInfoHost;

  @Input('selectedKeyInfoHosts')
   set selectedKeyInfoHosts(keyInfoHosts: Array<SelectedKeyInfoHost>) {
    this.keyInfoHost = keyInfoHosts.find(p => p.redisId === this.redisId);
  }
  private typeIconMap = {
    list: 'list',
    set: 'settings_ethernet',
    zset: 'format_list_numbered',
    hash: 'subject',
    string: 'text_fields'
  };
  constructor() { }

  ngOnInit() {
  }

}
