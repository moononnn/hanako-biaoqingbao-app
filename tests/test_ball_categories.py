"""纸飞机收藏分类回归：分类行、按分类筛选、多选管理、批量放进分类/移出收藏。

真实 Qt、offscreen 平台，不显示也不操作桌面窗口；分类操作都打桩，
只验「界面点下去会发生什么请求、带什么参数」。

运行：python -B tests/test_ball_categories.py
"""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


def run_child():
    import importlib.util
    os.environ['QT_QPA_PLATFORM'] = 'offscreen'
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix='bqb-cat-') as temp:
        os.environ['BIAOQINGBAO_BALL_STATE_PATH'] = str(Path(temp) / 'state.json')
        root = Path(__file__).resolve().parents[1] / 'python'
        sys.path.insert(0, str(root))
        spec = importlib.util.spec_from_file_location('ball_under_test', root / 'ball_app.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        calls = []
        stickers = [
            {'id': 's1', 'description': '猫', 'categoryIds': ['c1']},
            {'id': 's2', 'description': '狗', 'categoryIds': []},
            {'id': 's3', 'description': '猪', 'categoryIds': ['c1', 'c2']},
        ]

        def request(method, route, payload=None, timeout=10):
            calls.append((method, route, payload))
            if route == '/pinned':
                return {
                    'ok': True,
                    'stickers': stickers,
                    'categories': [
                        {'id': 'c1', 'name': '摸鱼', 'count': 2},
                        {'id': 'c2', 'name': '打工人', 'count': 1},
                    ],
                }
            if route == '/category-set-batch':
                return {'ok': True, 'count': len(payload.get('stickerIds') or [])}
            if route == '/category-remove-batch':
                return {'ok': True, 'count': len(payload.get('stickerIds') or [])}
            if route == '/unpin-batch':
                return {'ok': True, 'count': len(payload.get('stickerIds') or [])}
            if route == '/category-rename':
                return {'ok': True, 'category': {'id': payload.get('id'), 'name': payload.get('name')}}
            if route == '/category-delete':
                return {'ok': True}
            return {'ok': True}

        module.request_json = request
        module.load_image_data = lambda sticker_id: None

        app = module.QApplication([])
        app.setQuitOnLastWindowClosed(False)
        ball = module.Ball()
        panel = ball.panel
        panel.prepare_for_show()
        panel.show()

        seen = {}
        errors = []
        phase = {'name': 'load'}
        started = {'t': time.time()}

        def fail(message):
            errors.append(message)
            app.quit()

        def tick():
            if errors:
                return
            try:
                name = phase['name']
                elapsed = time.time() - started['t']
                if name == 'load':
                    if not panel.items:
                        if elapsed > 8:
                            fail('图集一直没加载出来')
                        return
                    # 分类行只留分类本身：全部 / 各分类 / ＋分类（管理已挪到面板右上角）
                    labels = [b.text() for b in panel.category_row_host.findChildren(module.QPushButton)
                              if not b.isHidden()]
                    seen['bar_labels'] = labels
                    if not any('全部' in text for text in labels):
                        fail('分类行应有「全部」：%r' % (labels,))
                    if not any('摸鱼' in text for text in labels):
                        fail('分类行应有「摸鱼」：%r' % (labels,))
                    if not any('打工人' in text for text in labels):
                        fail('分类行应有「打工人」：%r' % (labels,))
                    if not panel.add_category_btn.isHidden():
                        fail('平时不该露出「＋分类」（先进管理态）')
                    if any('改名' == text or '删分类' == text for text in labels):
                        fail('平时不该露出改名/删分类：%r' % (labels,))
                    if any('管理' in text for text in labels):
                        fail('分类行不该再有「管理」（已挪到右上角）：%r' % (labels,))
                    if panel.btn_manage.text() != '管理' or not panel.btn_manage.isVisible():
                        fail('右上角应有「管理」按钮：%r' % (panel.btn_manage.text(),))
                    if panel.btn_history.isVisible():
                        fail('配图手帐入口本轮应隐藏')
                    # 图集里的方图要裁成圆角：四角透明、中心不透明
                    probe = module.QPixmap(20, 20)
                    probe.fill(module.Qt.GlobalColor.black)
                    rounded = module.rounded_pixmap(probe, 20)
                    rounded_img = rounded.toImage()
                    if rounded_img.pixelColor(0, 0).alpha() != 0 or rounded_img.pixelColor(10, 10).alpha() != 255:
                        fail('rounded_pixmap 没把四角裁掉')
                    if len(panel._visible_items()) != 3:
                        fail('默认应显示全部收藏：%d' % len(panel._visible_items()))
                    phase['name'] = 'filter'
                    started['t'] = time.time()
                    return
                if name == 'filter':
                    panel._select_category('c1')
                    visible = [str(item.get('id')) for item in panel._visible_items()]
                    seen['filtered'] = visible
                    if sorted(visible) != ['s1', 's3']:
                        fail('按「摸鱼」筛选后应只剩 s1、s3：%r' % (visible,))
                    panel._select_category('c1')
                    if len(panel._visible_items()) != 3:
                        fail('再点一次应回到全部收藏')
                    phase['name'] = 'manage'
                    started['t'] = time.time()
                    return
                if name == 'manage':
                    panel._toggle_manage()
                    seen['manage_bar_visible'] = panel.manage_bar.isVisible()
                    seen['editor_hidden'] = panel.editor.isHidden()
                    if not panel.manage_bar.isVisible():
                        fail('管理态应显示批量操作条')
                    if not panel.editor.isHidden():
                        fail('管理态应收起发送框')
                    if panel.btn_manage.text() != '完成' or panel.btn_manage.property('active') is not True:
                        fail('管理态右上角按钮应变「完成」并亮起来：%r/%r' % (
                            panel.btn_manage.text(), panel.btn_manage.property('active')))
                    # 管理态点图 = 勾选，不是选待发送
                    panel.select_sticker('s2')
                    seen['picked'] = sorted(panel._manage_selected)
                    if panel._manage_selected != {'s2'}:
                        fail('管理态点图应加入多选：%r' % (panel._manage_selected,))
                    if panel.selected_sticker_id is not None:
                        fail('管理态不该改待发送选择')
                    # 全选只选当前视图里的
                    panel._manage_select_all()
                    seen['all_picked'] = sorted(panel._manage_selected)
                    if len(panel._manage_selected) != 3:
                        fail('全选应选中当前视图全部：%r' % (panel._manage_selected,))
                    phase['name'] = 'batch'
                    started['t'] = time.time()
                    return
                if name == 'batch':
                    panel._manage_selected = {'s1', 's2'}
                    panel._manage_batch_category()
                    picker = panel._category_picker
                    if picker is None:
                        fail('应弹出分类选择层')
                        return
                    seen['picker_title'] = picker.title.text()
                    if '2 张' not in picker.title.text():
                        fail('批量弹层标题应说明几张：' + picker.title.text())
                    boxes = picker.list_host.findChildren(module.QCheckBox)
                    seen['box_count'] = len(boxes)
                    if len(boxes) != 2:
                        fail('弹层应列出两个分类：%d' % len(boxes))
                    if any(box.isChecked() for box in boxes):
                        fail('批量模式初始不该预勾（勾的是要加进去的）')
                    boxes[0].setChecked(True)
                    picker._submit()
                    seen['batch_call'] = [c for c in calls if c[1] == '/category-set-batch']
                    if not seen['batch_call']:
                        fail('保存后应调 /category-set-batch')
                        return
                    method, route, payload = seen['batch_call'][-1]
                    if sorted(payload.get('stickerIds') or []) != ['s1', 's2']:
                        fail('批量参数里的图不对：%r' % (payload,))
                    if [str(v) for v in (payload.get('categoryIds') or [])] != ['c1']:
                        fail('批量参数里的分类不对：%r' % (payload,))
                    phase['name'] = 'unpin'
                    started['t'] = time.time()
                    return
                if name == 'unpin':
                    panel._manage_selected = {'s2'}
                    panel._manage_batch_unpin()
                    seen['unpin_call'] = [c for c in calls if c[1] == '/unpin-batch']
                    if not seen['unpin_call']:
                        fail('移出收藏应调 /unpin-batch')
                        return
                    method, route, payload = seen['unpin_call'][-1]
                    if [str(v) for v in (payload.get('stickerIds') or [])] != ['s2']:
                        fail('移出收藏参数不对：%r' % (payload,))
                    # 批量移出分类
                    panel._category_filter = 'c1'
                    panel._manage_selected = {'s1'}
                    panel._manage_batch_remove_category()
                    seen['remove_call'] = [c for c in calls if c[1] == '/category-remove-batch']
                    if not seen['remove_call']:
                        fail('移出分类应调 /category-remove-batch')
                        return
                    method, route, payload = seen['remove_call'][-1]
                    if str(payload.get('categoryId')) != 'c1':
                        fail('移出分类参数里的分类不对：%r' % (payload,))
                    # 退出管理态：发送框回来，右上角按钮变回「管理」
                    panel._toggle_manage()
                    if panel.manage_bar.isVisible() or panel.editor.isHidden():
                        fail('退出管理态后应恢复发送框')
                    if panel.btn_manage.text() != '管理':
                        fail('退出管理态后右上角按钮应变回「管理」：%r' % (panel.btn_manage.text(),))
                    # 拖动排序只挪格子、不重建按钮：重建会把正在播放的动图一起带走（0xC0000005 老座）
                    before = {key: id(btn) for key, btn in panel._buttons_by_id.items()}
                    order = list(panel.items)
                    panel.items = order[1:] + order[:1]
                    if not panel._reslot_grid():
                        fail('重排应能落到已有按钮上')
                    after = {key: id(btn) for key, btn in panel._buttons_by_id.items()}
                    if before != after:
                        fail('重排不该重建按钮对象')
                    placed = []
                    for slot in range(panel.grid.count()):
                        widget = panel.grid.itemAt(slot).widget()
                        if isinstance(widget, module.StickerButton):
                            placed.append(str(widget.item.get('id')))
                    expected = [str(item.get('id')) for item in panel._visible_items()]
                    if placed != expected:
                        fail('重排后的格子顺序不对：%r vs %r' % (placed, expected))
                    # dispose 要把动图引用交出去，不能留着悬空
                    probe_button = next(iter(panel._buttons_by_id.values()))
                    probe_button.dispose()
                    if probe_button._movie is not None:
                        fail('dispose 后不该还持有 QMovie')
                    # 管理态的分类编辑：＋分类露出来，选中分类后能改名 / 删分类
                    panel._toggle_manage()
                    def bar_texts():
                        # 只看当前布局里的控件：刚被 takeAt 掉的旧按钮还在 children 里，别混进来
                        texts = []
                        for index in range(panel.category_row.count()):
                            widget = panel.category_row.itemAt(index).widget()
                            if widget is not None:
                                texts.append(widget.text())
                        return texts
                    if panel.add_category_btn.isHidden():
                        fail('管理态应收出「＋分类」：%r' % (bar_texts(),))
                    panel._category_filter = 'c1'
                    panel._render_category_bar()
                    if panel.category_tools.isHidden():
                        fail('管理态选中分类后应露出改名/删分类那一行：%r' % (bar_texts(),))
                    if '摸鱼' not in panel.category_tools_label.text():
                        fail('分类工具行应说明正在管哪个分类：%r' % (panel.category_tools_label.text(),))
                    if panel.btn_cat_delete.text() != '删分类':
                        fail('删分类按钮初始文案不对：%r' % (panel.btn_cat_delete.text(),))
                    panel.btn_cat_rename.click()
                    prompt = getattr(panel, '_text_prompt', None)
                    if prompt is None:
                        fail('改名应弹出输入卡片')
                        return
                    if prompt.edit.text() != '摸鱼':
                        fail('改名弹层应预填当前名字：%r' % (prompt.edit.text(),))
                    prompt.edit.setText('划水')
                    prompt._submit()
                    rename_calls = [c for c in calls if c[1] == '/category-rename']
                    if not rename_calls:
                        fail('改名应调 /category-rename')
                        return
                    _method, _route, rename_payload = rename_calls[-1]
                    if str(rename_payload.get('id')) != 'c1' or rename_payload.get('name') != '划水':
                        fail('改名参数不对：%r' % (rename_payload,))
                    # 删分类两步：第一下只把文字变掉，第二下才真删
                    panel.btn_cat_delete.click()
                    if panel.btn_cat_delete.text() != '再点一次':
                        fail('第一下点删分类应变成「再点一次」：%r' % (panel.btn_cat_delete.text(),))
                    if [c for c in calls if c[1] == '/category-delete']:
                        fail('第一下不该真的删')
                    panel.btn_cat_delete.click()
                    delete_calls = [c for c in calls if c[1] == '/category-delete']
                    if not delete_calls:
                        fail('再点一次应调 /category-delete')
                        return
                    if str(delete_calls[-1][2].get('id')) != 'c1':
                        fail('删分类参数不对：%r' % (delete_calls[-1][2],))
                    timer.stop()
                    panel.shutdown()
                    print('PASS real Qt category flow ' + repr(sorted(seen)), flush=True)
                    app.quit()
            except Exception as error:  # noqa: BLE001 - 子进程里要留下原因
                fail(repr(error))

        timer = module.QTimer(panel)
        timer.timeout.connect(tick)
        timer.start(100)
        module.QTimer.singleShot(30000, app.quit)
        app.exec()
        timer.stop()
        ball.close()
        app.processEvents()
        panel._worker_drain_timer.stop()
        from PyQt6 import sip
        sip.delete(panel)
        sip.delete(ball)
        assert not errors, errors
        assert seen.get('manage_bar_visible') and seen.get('editor_hidden')
        assert seen.get('filtered') == ['s1', 's3']
        assert seen.get('batch_call') and seen.get('unpin_call') and seen.get('remove_call')


class BallCategoriesTest(unittest.TestCase):
    def test_category_bar_filter_and_batch_manage(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', QT_QPA_PLATFORM='offscreen')
        result = subprocess.run([sys.executable, '-B', __file__, '--child'],
                                env=env, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0,
                         'exit=' + hex(result.returncode & 0xffffffff) + '\n' +
                         result.stdout.decode('utf-8', 'replace')[-800:] + '\n' +
                         result.stderr.decode('utf-8', 'replace')[-6000:])
        self.assertIn(b'PASS real Qt category flow', result.stdout)


if __name__ == '__main__':
    if '--child' in sys.argv:
        run_child()
    else:
        unittest.main()
