import { FixedPointDecimal } from '@handsoff/fixed-point';
import { sizePosition, SizingError } from '../sizing';

describe('sizePosition', () => {
  const prices = {
    long: new FixedPointDecimal('100'),
    short: new FixedPointDecimal('100'),
  };

  it('returns long notional, short notional, and per-leg margin', () => {
    const result = sizePosition({
      capital: new FixedPointDecimal('1000'),
      targetLeverage: new FixedPointDecimal('2'),
      prices,
    });

    expect(result.longNotional.toString()).toBe('2000');
    expect(result.shortNotional.toString()).toBe('2000');
    expect(result.longMargin.toString()).toBe('1000');
    expect(result.shortMargin.toString()).toBe('1000');
  });

  it('sizes across leverage levels', () => {
    const capital = new FixedPointDecimal('500');

    const one = sizePosition({
      capital,
      targetLeverage: new FixedPointDecimal('1'),
      prices,
    });
    expect(one.longNotional.toString()).toBe('500');
    expect(one.shortNotional.toString()).toBe('500');
    expect(one.longMargin.toString()).toBe('500');
    expect(one.shortMargin.toString()).toBe('500');

    const three = sizePosition({
      capital,
      targetLeverage: new FixedPointDecimal('3'),
      prices,
    });
    expect(three.longNotional.toString()).toBe('1500');
    expect(three.shortNotional.toString()).toBe('1500');
    expect(three.longMargin.toString()).toBe('500');
    expect(three.shortMargin.toString()).toBe('500');
  });

  it('uses each leg price for its notional', () => {
    const result = sizePosition({
      capital: new FixedPointDecimal('1000'),
      targetLeverage: new FixedPointDecimal('2'),
      prices: {
        long: new FixedPointDecimal('50'),
        short: new FixedPointDecimal('200'),
      },
    });

    expect(result.longNotional.toString()).toBe('2000');
    expect(result.shortNotional.toString()).toBe('2000');
    expect(result.longMargin.toString()).toBe('1000');
    expect(result.shortMargin.toString()).toBe('1000');
  });

  it('rejects non-positive capital with a typed error', () => {
    expect(() =>
      sizePosition({
        capital: new FixedPointDecimal('0'),
        targetLeverage: new FixedPointDecimal('2'),
        prices,
      }),
    ).toThrow(SizingError);

    expect(() =>
      sizePosition({
        capital: new FixedPointDecimal('-1'),
        targetLeverage: new FixedPointDecimal('2'),
        prices,
      }),
    ).toThrow(SizingError);
  });

  it('rejects out-of-range leverage with a typed error', () => {
    expect(() =>
      sizePosition({
        capital: new FixedPointDecimal('1000'),
        targetLeverage: new FixedPointDecimal('0'),
        prices,
      }),
    ).toThrow(SizingError);

    expect(() =>
      sizePosition({
        capital: new FixedPointDecimal('1000'),
        targetLeverage: new FixedPointDecimal('101'),
        prices,
      }),
    ).toThrow(SizingError);
  });
});
