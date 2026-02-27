import { Agent, callable } from 'agents';

export interface SplashDeviceState {
  isSplashSponsor: boolean;
  activatedAt: number;
  address: string;
}

interface Env {}

export class SplashDeviceAgent extends Agent<Env, SplashDeviceState> {
  initialState: SplashDeviceState = {
    isSplashSponsor: false,
    activatedAt: 0,
    address: '',
  };

  @callable()
  async activate(params: { address: string }): Promise<{ success: boolean }> {
    const { address } = params;
    if (!address) return { success: false };
    this.setState({
      isSplashSponsor: true,
      activatedAt: Date.now(),
      address,
    });
    return { success: true };
  }

  @callable()
  async check(): Promise<{ isSplashSponsor: boolean }> {
    return { isSplashSponsor: this.state.isSplashSponsor };
  }

  @callable()
  async deactivate(): Promise<{ success: boolean }> {
    this.setState({ ...this.state, isSplashSponsor: false });
    return { success: true };
  }
}
