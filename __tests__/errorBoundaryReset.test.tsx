import { ErrorBoundary } from '@/components/ErrorBoundary';

describe('ErrorBoundary resetKey', () => {
  test('切換股票或日期後清除先前模組錯誤', () => {
    const boundary = new ErrorBoundary({ section: '訊號分析', resetKey: '6770:2026-08-14', children: null });
    boundary.state = { hasError: true, error: new Error('bad payload') };
    const reset = jest.spyOn(boundary, 'setState').mockImplementation(() => undefined);

    boundary.componentDidUpdate({ section: '訊號分析', resetKey: '3081:2026-08-14', children: null });

    expect(reset).toHaveBeenCalledWith({ hasError: false, error: null });
  });

  test('同一資料內容不會反覆重置', () => {
    const boundary = new ErrorBoundary({ section: '訊號分析', resetKey: '6770:2026-08-14', children: null });
    boundary.state = { hasError: true, error: new Error('bad payload') };
    const reset = jest.spyOn(boundary, 'setState').mockImplementation(() => undefined);

    boundary.componentDidUpdate({ section: '訊號分析', resetKey: '6770:2026-08-14', children: null });

    expect(reset).not.toHaveBeenCalled();
  });
});
